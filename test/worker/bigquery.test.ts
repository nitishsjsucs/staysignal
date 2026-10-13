// The production warehouse client (SPEC 7.3, 17.2, path B) against a mocked BigQuery: a signed service-account JWT
// exchanged for a cached token, every job parameterized with the bytes cap, the app label and the location, published
// documents read by key, and semantic-catalog entries run as compiled with server-bound values. Nothing leaves the test.
import { describe, expect, it } from "vitest";
import catalog from "../../src/worker/generated/catalog.bigquery.json";
import { parseConfig } from "../../src/worker/config";
import { sha256HexSync } from "../../src/worker/store/chain";
import { BigQueryWarehouse, MAX_BYTES_BILLED, PROJECT_PLACEHOLDER } from "../../src/worker/warehouse/bigquery";

async function serviceAccount() {
  const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return { publicKey: kp.publicKey, sa: { client_email: "staysignal-worker@proj-test.iam.gserviceaccount.com", private_key: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n` } };
}

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

describe("BigQuery client", () => {
  it("signs a JWT, caches the token and caps, labels and parameterizes every job", async () => {
    const { publicKey, sa } = await serviceAccount();
    const calls: { url: string; body: string; auth: string | null }[] = [];
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: String(init?.body), auth: new Headers(init?.headers).get("authorization") });
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        const assertion = new URLSearchParams(String(init?.body)).get("assertion")!;
        const [h, c, s] = assertion.split(".");
        const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, fromB64url(s!), new TextEncoder().encode(`${h}.${c}`));
        const claims = JSON.parse(new TextDecoder().decode(fromB64url(c!)));
        expect(ok).toBe(true);
        expect(claims).toMatchObject({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/bigquery", aud: "https://oauth2.googleapis.com/token" });
        return Response.json({ access_token: "at-1", expires_in: 3600 });
      }
      const body = JSON.parse(String(init?.body));
      if (String(body.query).includes("staysignal_published.documents")) {
        return Response.json({ jobComplete: true, schema: { fields: [{ name: "doc", type: "STRING" }] }, rows: [{ f: [{ v: JSON.stringify({ published: "R-2026-10-01#1", runs: [] }) }] }] });
      }
      return Response.json({ jobComplete: true, schema: { fields: [{ name: "headcount", type: "INTEGER" }, { name: "metric_time__month", type: "TIMESTAMP" }, { name: "voluntary_departures", type: "FLOAT" }] }, rows: [{ f: [{ v: "1998" }, { v: "1759276800" }, { v: "12.0" }] }] });
    }) as typeof fetch;
    const bq = new BigQueryWarehouse({ projectId: "proj-test", location: "US", serviceAccount: sa }, fake);
    const wrapped = Object.create(bq) as BigQueryWarehouse; // as warehouseFor wraps it
    expect((await bq.runs()).published).toBe("R-2026-10-01#1");
    const res = await wrapped.catalog("workforce_flows|company|none", { start_month: "2025-10", end_month: "2026-09", scope: ["Engineering"] });
    expect(calls.filter((c) => c.url.includes("oauth2")).length).toBe(1); // the token is cached, through the wrapper too
    const queries = calls.filter((c) => c.url.includes("/queries"));
    expect(queries.every((q) => q.auth === "Bearer at-1" && q.url === "https://bigquery.googleapis.com/bigquery/v2/projects/proj-test/queries")).toBe(true);
    for (const q of queries) {
      const body = JSON.parse(q.body);
      expect(body).toMatchObject({ useLegacySql: false, parameterMode: "NAMED", maximumBytesBilled: String(MAX_BYTES_BILLED), labels: { app: "staysignal" }, location: "US" });
    }
    const doc = JSON.parse(queries[0]!.body);
    expect(doc.query).toBe("SELECT doc FROM `proj-test.staysignal_published.documents` WHERE key = @key");
    expect(doc.queryParameters).toEqual([{ name: "key", parameterType: { type: "STRING" }, parameterValue: { value: "runs.json" } }]);
    const cat = JSON.parse(queries[1]!.body);
    expect(cat.query).not.toContain(PROJECT_PLACEHOLDER);
    expect(cat.query).toContain("`proj-test`.`staysignal_published`.`rpt_flows_monthly`");
    const params = Object.fromEntries((cat.queryParameters as { name: string; parameterValue: unknown }[]).map((p) => [p.name, p.parameterValue]));
    expect(params).toEqual({
      start_month: { value: "2025-10-01 00:00:00" },
      end_month: { value: "2026-09-01 00:00:00" },
      f_organization: { arrayValues: [{ value: "__all__" }] },
      f_group_name: { arrayValues: [{ value: "__all__" }] },
      scope_organizations: { arrayValues: [{ value: "Engineering" }] },
    });
    const entry = (catalog as { entries: Record<string, { sql: string }> }).entries["workforce_flows|company|none"]!;
    expect(res).toEqual({ key: "workforce_flows|company|none", label: "synthetic", columns: ["headcount", "metric_time__month", "voluntary_departures"], rows: [[1998, "2025-10-01", 12]], sql_sha256: sha256HexSync(entry.sql) });
    expect(await wrapped.catalog("not-a-key", { start_month: "2025-10", end_month: "2026-09" })).toBeNull();
  });

  it("fails closed without the project or the key", () => {
    expect(() => parseConfig({ SS_DATA_MODE: "bigquery" } as unknown as Env)).toThrow(/SS_GCP_PROJECT_ID/);
  });
});
