// The production warehouse client (SPEC 7.3, 17.2, 18, path B): BigQuery REST from the Worker. Published documents
// (runs, forecasts, history, quality, lineage, evaluation, the action audit) are rows of
// `staysignal_published.documents` keyed by the same paths the fixtures use; semantic-catalog entries run as compiled
// for BigQuery (src/worker/generated/catalog.bigquery.json) with server-bound named parameters, never model-written SQL.
// Every job carries maximumBytesBilled (100 MiB for the Worker) and the label app=staysignal. The service account key
// is the SS_GCP_SA_KEY secret; tokens come from a signed JWT (RS256 through WebCrypto) and are cached until a minute
// before expiry. Memory is not here: production memory lives in the WorkspaceAgent (warehouseFor wraps it).
import type { ActionAuditDoc, CatalogRequest, CatalogResult, ChangesFixture, EvaluationFixture, ForecastFixture, HistoryFixture, LabDoc, LabIndex, MemoryCommit, MemoryFileDoc, MemoryFileInfo, ProfilesFixture, QualityFixture, RunsIndex } from "../../shared/contracts";
import type { MemoryHit } from "../../shared/memory/search";
import type { LineageFixture, WarehouseClient } from "../../shared/tools/registry";
import catalog from "../generated/catalog.bigquery.json";
import { sha256HexSync } from "../store/chain";
import { slug } from "./fixtures";

export const MAX_BYTES_BILLED = 104_857_600;
export const JOB_LABELS = { app: "staysignal" } as const;
export const PROJECT_PLACEHOLDER = (catalog as { header: { project_placeholder: string } }).header.project_placeholder;
const ALL = "__all__";
const SCOPE = "https://www.googleapis.com/auth/bigquery";

export interface BigQueryConfig {
  projectId: string;
  location: string;
  serviceAccount: { client_email: string; private_key: string; token_uri?: string };
}

type QueryParam = { name: string; parameterType: { type: string; arrayType?: { type: string } }; parameterValue: { value?: string; arrayValues?: { value: string }[] } };

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = new TextEncoder();

async function signJwt(sa: BigQueryConfig["serviceAccount"], now: number): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const iat = Math.floor(now / 1000);
  const claims = b64url(enc.encode(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 })));
  const pem = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${header}.${claims}`)));
  return `${header}.${claims}.${b64url(sig)}`;
}

function scalar(type: string, value: string | null): string | number | null {
  if (value === null) return null;
  if (type === "INTEGER" || type === "INT64") return Number(value);
  if (type === "FLOAT" || type === "FLOAT64" || type === "NUMERIC" || type === "BIGNUMERIC") return Number(value);
  if (type === "TIMESTAMP") return new Date(Number(value) * 1000).toISOString().slice(0, 10);
  return value;
}

export class BigQueryWarehouse implements WarehouseClient {
  readonly mode = "bigquery" as const;
  // an object, not a field: warehouseFor wraps this client with Object.create, and a write through the wrapper must
  // still land in the one cache the isolate shares
  private readonly cache: { token: { value: string; expires: number } | null } = { token: null };

  constructor(
    private readonly cfg: BigQueryConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async accessToken(): Promise<string> {
    const cached = this.cache.token;
    if (cached && cached.expires - 60_000 > this.now()) return cached.value;
    const assertion = await signJwt(this.cfg.serviceAccount, this.now());
    const r = await this.fetchImpl(this.cfg.serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    if (!r.ok) throw new Error(`token exchange failed: ${r.status}`);
    const t = (await r.json()) as { access_token: string; expires_in: number };
    this.cache.token = { value: t.access_token, expires: this.now() + t.expires_in * 1000 };
    return t.access_token;
  }

  /** One parameterized query job with the bytes cap and the app label; rows typed by the result schema. */
  async query(sql: string, params: QueryParam[]): Promise<{ columns: string[]; rows: (string | number | null)[][] }> {
    const r = await this.fetchImpl(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(this.cfg.projectId)}/queries`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ query: sql, useLegacySql: false, parameterMode: "NAMED", queryParameters: params, maximumBytesBilled: String(MAX_BYTES_BILLED), labels: JOB_LABELS, location: this.cfg.location, timeoutMs: 10_000 }),
    });
    if (!r.ok) throw new Error(`BigQuery query failed: ${r.status}`);
    const j = (await r.json()) as { jobComplete: boolean; schema?: { fields: { name: string; type: string }[] }; rows?: { f: { v: string | null }[] }[] };
    if (!j.jobComplete) throw new Error("BigQuery query did not complete within 10 s");
    const fields = j.schema?.fields ?? [];
    return { columns: fields.map((f) => f.name), rows: (j.rows ?? []).map((row) => row.f.map((cell, i) => scalar(fields[i]!.type, cell.v))) };
  }

  private async doc<T>(key: string): Promise<T | null> {
    const out = await this.query(`SELECT doc FROM \`${this.cfg.projectId}.staysignal_published.documents\` WHERE key = @key`, [{ name: "key", parameterType: { type: "STRING" }, parameterValue: { value: key } }]);
    const v = out.rows[0]?.[0];
    return typeof v === "string" ? (JSON.parse(v) as T) : null;
  }

  async runs(): Promise<RunsIndex> {
    const r = await this.doc<RunsIndex>("runs.json");
    if (!r) throw new Error("no published runs in BigQuery");
    return r;
  }
  forecast(runId: string) {
    return this.doc<ForecastFixture>(`forecast/${slug(runId)}.json`);
  }
  history() {
    return this.doc<HistoryFixture>("history.json");
  }
  changes(fromRun: string, toRun: string) {
    return this.doc<ChangesFixture>(`changes/${slug(fromRun)}__${slug(toRun)}.json`);
  }
  quality() {
    return this.doc<QualityFixture>("quality.json");
  }
  lineage() {
    return this.doc<LineageFixture>("lineage.json");
  }
  profiles(runId: string) {
    return this.doc<ProfilesFixture>(`profiles/${slug(runId)}.json`);
  }
  evaluation() {
    return this.doc<EvaluationFixture>("evaluation.json");
  }
  actionAudit() {
    return this.doc<ActionAuditDoc>("action-audit.json");
  }

  async catalog(key: string, request: CatalogRequest): Promise<CatalogResult | null> {
    const entry = (catalog as { entries: Record<string, { sql: string; params: { name: string; type: string }[] }> }).entries[key];
    if (!entry) return null;
    const month = (m: string) => `${m}-01 00:00:00`;
    const list = (xs: string[] | undefined) => (xs && xs.length ? xs : [ALL]);
    const values: Record<string, string | string[]> = { start_month: month(request.start_month), end_month: month(request.end_month), f_organization: list(request.organizations), f_group_name: list(request.groups), scope_organizations: list(request.scope) };
    const params: QueryParam[] = entry.params.map((p) => {
      const v = values[p.name]!;
      return Array.isArray(v)
        ? { name: p.name, parameterType: { type: "ARRAY", arrayType: { type: "STRING" } }, parameterValue: { arrayValues: v.map((x) => ({ value: x })) } }
        : { name: p.name, parameterType: { type: p.type }, parameterValue: { value: v } };
    });
    const out = await this.query(entry.sql.split(PROJECT_PLACEHOLDER).join(this.cfg.projectId), params);
    return { key, label: "synthetic", columns: out.columns, rows: out.rows, sql_sha256: sha256HexSync(entry.sql) };
  }

  // production memory is the WorkspaceAgent's store; warehouseFor supplies it
  async memoryFiles(): Promise<MemoryFileInfo[] | null> {
    return null;
  }
  async memoryFile(): Promise<MemoryFileDoc | null> {
    return null;
  }
  async memoryLog(): Promise<MemoryCommit[] | null> {
    return null;
  }
  async memorySearch(): Promise<MemoryHit[] | null> {
    return null;
  }

  async labIndex(): Promise<LabIndex | null> {
    return this.doc<LabIndex>("lab/index.json");
  }

  async lab(proposal: string): Promise<LabDoc | null> {
    if (!/^[a-z0-9-]{3,60}$/.test(proposal)) return null;
    return this.doc<LabDoc>(`lab/${proposal}.json`);
  }
}
