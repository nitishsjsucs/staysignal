// Fail-closed configuration from the Worker environment.
export interface AppConfig {
  /** "demo": the public demo (ADR 0018), signed session cookies and a private sandbox per visitor. */
  authMode: "dev" | "access" | "demo";
  dataMode: "fixtures" | "engine" | "bigquery";
  llm: "stub" | "recorded" | "llama" | "mlx" | "workers-ai";
  /** "external": a runner leases engine jobs (the local engine or the fixture runner); "inline": a fixtures
   * deployment completes each job from the committed job fixtures as it is enqueued (no runner). */
  runner: "external" | "inline";
  /** SS_DEMO=1: recorded model output only (llm is always "recorded"); stub and live providers are off. */
  demo: boolean;
  /** The public demo (SS_AUTH_MODE=demo with SS_PUBLIC_DEMO=1, ADR 0018): the session key, or null. */
  publicDemo: { signingKey: string } | null;
  /** What the recorded provider does with a question it has no recording for: a short message (the interview demo,
   * SS_DEMO=1) or the labeled deterministic stub (the public demo). */
  chatFallback: "message" | "stub";
  /** Where the replayed model output was recorded, as the provenance line says it. */
  recordedOn: string;
  engineUrl: string;
  devJwks: string | null;
  devSigningJwk: string | null;
  access: { teamDomain: string; aud: string };
  hmacKey: string;
  runnerToken: string | null;
  serviceTokens: { runner: string | null; mcp: string | null };
  roleBindings: string | null;
  /** The production warehouse (SS_DATA_MODE=bigquery): project, location and the service account key secret. */
  bigquery: { projectId: string; location: string; serviceAccount: { client_email: string; private_key: string; token_uri?: string } } | null;
  /** The production model through AI Gateway (SS_LLM=workers-ai); null otherwise. */
  workersAi: { accountId: string; gatewayId: string; token: string; model: string; dailyNeuronCap: number } | null;
}

export const DEV_ISSUER = "http://localhost/dev-access";
export const DEV_AUDIENCE = "staysignal-dev";
// Fixed CI and local key (base64 of bytes 0..31), the same as the engine's TEST_MASTER_KEY. Production sets
// SS_HMAC_MASTER_KEY as a Worker secret.
export const TEST_HMAC_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

/** Base64 or base64url of the key bytes, or null when it is not valid base64. */
export function decodeKey(text: string | undefined): Uint8Array | null {
  if (!text) return null;
  const t = text.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null;
  try {
    const bin = atob(t.padEnd(Math.ceil(t.length / 4) * 4, "="));
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

export const DEMO_KEY_MIN_BYTES = 32;

const set = (v: string | undefined): boolean => v !== undefined && v.trim() !== "";

/** Every reason the public demo would be unsafe to start (ADR 0018); empty when it may start. The demo serves the
 * committed fixtures only: no BigQuery, no runner or MCP token, no Workers AI or AI Gateway, no Access. */
export function publicDemoProblems(env: Env): string[] {
  const e = env as unknown as Record<string, string | undefined>;
  const out: string[] = [];
  if (e.SS_PUBLIC_DEMO !== "1") out.push("SS_AUTH_MODE=demo needs SS_PUBLIC_DEMO=1");
  const key = decodeKey(e.SS_DEMO_SIGNING_KEY);
  if (!key || key.length < DEMO_KEY_MIN_BYTES) out.push(`SS_AUTH_MODE=demo needs the secret SS_DEMO_SIGNING_KEY: base64 of at least ${DEMO_KEY_MIN_BYTES} random bytes`);
  if ((e.SS_DATA_MODE ?? "fixtures") !== "fixtures") out.push("demo mode serves the committed fixtures only (SS_DATA_MODE=fixtures)");
  for (const name of ["SS_GCP_PROJECT_ID", "SS_GCP_SA_KEY"]) if (set(e[name])) out.push(`demo mode never reads BigQuery (${name} is set)`);
  if (e.SS_LLM === "workers-ai" || e.SS_LLM === "llama" || e.SS_LLM === "mlx") out.push(`demo mode never calls a live model (SS_LLM=${e.SS_LLM})`);
  for (const name of ["SS_AIG_ACCOUNT_ID", "SS_AIG_GATEWAY_ID", "SS_AIG_TOKEN"]) if (set(e[name])) out.push(`demo mode never calls Workers AI or AI Gateway (${name} is set)`);
  if ((env as unknown as { AI?: unknown }).AI !== undefined) out.push("demo mode never calls Workers AI (an AI binding is declared)");
  for (const name of ["SS_RUNNER_TOKEN", "SS_RUNNER_TOKEN_ID"]) if (set(e[name])) out.push(`demo mode has no runner (${name} is set)`);
  if (set(e.SS_MCP_TOKEN_ID)) out.push("demo mode has no MCP server (SS_MCP_TOKEN_ID is set)");
  for (const name of ["SS_ACCESS_TEAM_DOMAIN", "SS_ACCESS_AUD", "SS_ROLE_BINDINGS"]) if (set(e[name])) out.push(`demo mode signs visitors in itself (${name} is set)`);
  if (!(env as unknown as { DEMO_GATE?: unknown }).DEMO_GATE) out.push("demo mode needs the DEMO_GATE Durable Object binding");
  return out;
}

export function parseConfig(env: Env): AppConfig {
  const e = env as unknown as Record<string, string | undefined>;
  const requested = e.SS_AUTH_MODE;
  if (requested === "demo") {
    const problems = publicDemoProblems(env);
    if (problems.length) throw new Error(`public demo refused: ${problems.join("; ")}`);
  } else if (e.SS_PUBLIC_DEMO === "1") {
    throw new Error("SS_PUBLIC_DEMO=1 needs SS_AUTH_MODE=demo");
  }
  const authMode: AppConfig["authMode"] = requested === "access" ? "access" : requested === "demo" ? "demo" : "dev";
  const publicDemo = authMode === "demo" ? { signingKey: btoa(String.fromCharCode(...decodeKey(e.SS_DEMO_SIGNING_KEY)!)) } : null;
  const dataMode = (publicDemo ? "fixtures" : (e.SS_DATA_MODE ?? "fixtures")) as AppConfig["dataMode"];
  // the public demo is a demo: recorded model output, the Lab's recorded sessions only, recorded interview answers
  const demo = e.SS_DEMO === "1" || publicDemo !== null;
  // demo mode (npm run demo) replays recorded model output only: whatever SS_LLM says, no live model is reachable from
  // any path (the chat, the dev turn, the investigation, the persona interview). The operator's decision, 2026-10-13.
  const llm = (demo ? "recorded" : (e.SS_LLM ?? "stub")) as AppConfig["llm"];
  if (authMode === "access" && (!e.SS_ACCESS_TEAM_DOMAIN || !e.SS_ACCESS_AUD)) throw new Error("access mode needs SS_ACCESS_TEAM_DOMAIN and SS_ACCESS_AUD");
  if (dataMode === "bigquery" && (!e.SS_GCP_PROJECT_ID || !e.SS_GCP_SA_KEY)) throw new Error("SS_DATA_MODE=bigquery needs SS_GCP_PROJECT_ID and the SS_GCP_SA_KEY secret");
  if (llm === "workers-ai" && (!e.SS_AIG_ACCOUNT_ID || !e.SS_AIG_GATEWAY_ID || !e.SS_AIG_TOKEN)) throw new Error("SS_LLM=workers-ai needs SS_AIG_ACCOUNT_ID, SS_AIG_GATEWAY_ID and the SS_AIG_TOKEN secret");
  return {
    authMode,
    dataMode,
    llm,
    // the public demo has no runner: every engine job completes inline from the committed job fixtures
    runner: publicDemo || (e.SS_RUNNER === "inline" && dataMode === "fixtures") ? "inline" : "external",
    demo,
    publicDemo,
    chatFallback: publicDemo ? "stub" : "message",
    recordedOn: publicDemo ? "the author's laptop" : "this laptop",
    engineUrl: e.SS_ENGINE_URL ?? "http://127.0.0.1:8196",
    devJwks: authMode === "dev" ? (e.SS_DEV_JWKS ?? null) : null,
    devSigningJwk: authMode === "dev" ? (e.SS_DEV_SIGNING_JWK ?? null) : null,
    access: authMode === "access" ? { teamDomain: e.SS_ACCESS_TEAM_DOMAIN as string, aud: e.SS_ACCESS_AUD as string } : { teamDomain: DEV_ISSUER, aud: DEV_AUDIENCE },
    // agent instance names in the public demo: the signing key under its own HKDF info (src/worker/auth/hmac.ts)
    hmacKey: publicDemo ? publicDemo.signingKey : (e.SS_HMAC_MASTER_KEY ?? (authMode === "dev" ? TEST_HMAC_KEY : "")),
    runnerToken: publicDemo ? null : (e.SS_RUNNER_TOKEN ?? null),
    // Access service tokens: the JWT's common_name is the token's client ID, so production binds svc:<client ID>
    serviceTokens: publicDemo ? { runner: null, mcp: null } : { runner: e.SS_RUNNER_TOKEN_ID ?? null, mcp: e.SS_MCP_TOKEN_ID ?? null },
    roleBindings: publicDemo ? null : (e.SS_ROLE_BINDINGS ?? null),
    bigquery: dataMode === "bigquery" ? { projectId: e.SS_GCP_PROJECT_ID as string, location: e.SS_BQ_LOCATION ?? "US", serviceAccount: JSON.parse(e.SS_GCP_SA_KEY as string) as { client_email: string; private_key: string; token_uri?: string } } : null,
    workersAi:
      llm === "workers-ai"
        ? {
            accountId: e.SS_AIG_ACCOUNT_ID as string,
            gatewayId: e.SS_AIG_GATEWAY_ID as string,
            token: e.SS_AIG_TOKEN as string,
            model: e.SS_AI_MODEL ?? "@cf/qwen/qwen3-30b-a3b-fp8",
            dailyNeuronCap: Number(e.SS_AI_DAILY_NEURON_CAP ?? "1500"),
          }
        : null,
  };
}

export function isLocalHost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}
