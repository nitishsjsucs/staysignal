// Fail-closed configuration from the Worker environment.
export interface AppConfig {
  authMode: "dev" | "access";
  dataMode: "fixtures" | "engine" | "bigquery";
  llm: "stub" | "recorded" | "llama" | "mlx" | "workers-ai";
  /** "external": a runner leases engine jobs (the local engine or the fixture runner); "inline": a fixtures
   * deployment completes each job from the committed job fixtures as it is enqueued (no runner). */
  runner: "external" | "inline";
  demo: boolean;
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

export function parseConfig(env: Env): AppConfig {
  const e = env as unknown as Record<string, string | undefined>;
  const authMode = e.SS_AUTH_MODE === "access" ? "access" : "dev";
  const dataMode = (e.SS_DATA_MODE ?? "fixtures") as AppConfig["dataMode"];
  const llm = (e.SS_LLM ?? "stub") as AppConfig["llm"];
  if (authMode === "access" && (!e.SS_ACCESS_TEAM_DOMAIN || !e.SS_ACCESS_AUD)) throw new Error("access mode needs SS_ACCESS_TEAM_DOMAIN and SS_ACCESS_AUD");
  if (dataMode === "bigquery" && (!e.SS_GCP_PROJECT_ID || !e.SS_GCP_SA_KEY)) throw new Error("SS_DATA_MODE=bigquery needs SS_GCP_PROJECT_ID and the SS_GCP_SA_KEY secret");
  if (llm === "workers-ai" && (!e.SS_AIG_ACCOUNT_ID || !e.SS_AIG_GATEWAY_ID || !e.SS_AIG_TOKEN)) throw new Error("SS_LLM=workers-ai needs SS_AIG_ACCOUNT_ID, SS_AIG_GATEWAY_ID and the SS_AIG_TOKEN secret");
  return {
    authMode,
    dataMode,
    llm,
    runner: e.SS_RUNNER === "inline" && dataMode === "fixtures" ? "inline" : "external",
    demo: e.SS_DEMO === "1",
    engineUrl: e.SS_ENGINE_URL ?? "http://127.0.0.1:8196",
    devJwks: e.SS_DEV_JWKS ?? null,
    devSigningJwk: e.SS_DEV_SIGNING_JWK ?? null,
    access: authMode === "dev" ? { teamDomain: DEV_ISSUER, aud: DEV_AUDIENCE } : { teamDomain: e.SS_ACCESS_TEAM_DOMAIN as string, aud: e.SS_ACCESS_AUD as string },
    hmacKey: e.SS_HMAC_MASTER_KEY ?? (authMode === "dev" ? TEST_HMAC_KEY : ""),
    runnerToken: e.SS_RUNNER_TOKEN ?? null,
    // Access service tokens: the JWT's common_name is the token's client ID, so production binds svc:<client ID>
    serviceTokens: { runner: e.SS_RUNNER_TOKEN_ID ?? null, mcp: e.SS_MCP_TOKEN_ID ?? null },
    roleBindings: e.SS_ROLE_BINDINGS ?? null,
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
