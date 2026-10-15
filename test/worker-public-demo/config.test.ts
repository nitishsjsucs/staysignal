// ADR 0018 (the pure configuration rules, run in workerd beside the other public-demo tests): SS_AUTH_MODE=demo starts only with SS_PUBLIC_DEMO=1, a signing key of at least 32 bytes and the gate, and
// never together with a real data path: BigQuery, a live model, Workers AI or AI Gateway, runner or MCP tokens,
// Access. SS_PUBLIC_DEMO=1 with any other auth mode is refused too.
import { describe, expect, it } from "vitest";
import { parseConfig, publicDemoProblems } from "../../src/worker/config";

type E = Parameters<typeof parseConfig>[0];
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const KEY = b64(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const ok = { SS_AUTH_MODE: "demo", SS_PUBLIC_DEMO: "1", SS_DEMO_SIGNING_KEY: KEY, SS_DATA_MODE: "fixtures", DEMO_GATE: {} } as Record<string, unknown>;
const cfg = (patch: Record<string, unknown>) => parseConfig({ ...ok, ...patch } as unknown as E);

describe("the public demo's configuration", () => {
  it("starts with SS_PUBLIC_DEMO=1, a 32-byte key and the gate: recorded output with the stub fallback, no runner", () => {
    const c = cfg({});
    expect(c).toMatchObject({ authMode: "demo", dataMode: "fixtures", llm: "recorded", runner: "inline", demo: true, chatFallback: "stub", recordedOn: "the author's laptop", runnerToken: null, roleBindings: null, workersAi: null, bigquery: null });
    expect(c.publicDemo?.signingKey).toBe(KEY);
    expect(c.serviceTokens).toEqual({ runner: null, mcp: null });
    // base64url keys are accepted too
    expect(cfg({ SS_DEMO_SIGNING_KEY: KEY.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") }).publicDemo?.signingKey).toBe(KEY);
  });

  it("refuses to start without SS_PUBLIC_DEMO=1 or a key of at least 32 random bytes", () => {
    expect(() => cfg({ SS_PUBLIC_DEMO: undefined })).toThrow(/SS_PUBLIC_DEMO=1/);
    expect(() => cfg({ SS_PUBLIC_DEMO: "true" })).toThrow(/SS_PUBLIC_DEMO=1/);
    expect(() => cfg({ SS_DEMO_SIGNING_KEY: undefined })).toThrow(/SS_DEMO_SIGNING_KEY/);
    expect(() => cfg({ SS_DEMO_SIGNING_KEY: b64(new Uint8Array(31).fill(7)) })).toThrow(/at least 32/);
    expect(() => cfg({ SS_DEMO_SIGNING_KEY: "not base64!" })).toThrow(/SS_DEMO_SIGNING_KEY/);
    expect(() => cfg({ DEMO_GATE: undefined })).toThrow(/DEMO_GATE/);
  });

  it("refuses SS_PUBLIC_DEMO=1 with dev or Access auth", () => {
    expect(() => parseConfig({ SS_AUTH_MODE: "dev", SS_PUBLIC_DEMO: "1" } as unknown as E)).toThrow(/needs SS_AUTH_MODE=demo/);
    expect(() => parseConfig({ SS_AUTH_MODE: "access", SS_ACCESS_TEAM_DOMAIN: "https://x", SS_ACCESS_AUD: "a", SS_PUBLIC_DEMO: "1" } as unknown as E)).toThrow(/needs SS_AUTH_MODE=demo/);
  });

  it("never combines with BigQuery, a live model, Workers AI, runner or MCP tokens, or Access", () => {
    const refused: [Record<string, unknown>, RegExp][] = [
      [{ SS_DATA_MODE: "bigquery" }, /fixtures only/],
      [{ SS_DATA_MODE: "engine" }, /fixtures only/],
      [{ SS_GCP_PROJECT_ID: "p" }, /BigQuery/],
      [{ SS_GCP_SA_KEY: "{}" }, /BigQuery/],
      [{ SS_LLM: "workers-ai" }, /live model/],
      [{ SS_LLM: "mlx" }, /live model/],
      [{ SS_LLM: "llama" }, /live model/],
      [{ SS_AIG_TOKEN: "t" }, /Workers AI or AI Gateway/],
      [{ SS_AIG_ACCOUNT_ID: "a" }, /Workers AI or AI Gateway/],
      [{ AI: {} }, /AI binding/],
      [{ SS_RUNNER_TOKEN: "r" }, /no runner/],
      [{ SS_RUNNER_TOKEN_ID: "r.access" }, /no runner/],
      [{ SS_MCP_TOKEN_ID: "m.access" }, /no MCP/],
      [{ SS_ACCESS_AUD: "a" }, /signs visitors in itself/],
      [{ SS_ROLE_BINDINGS: "{}" }, /signs visitors in itself/],
    ];
    for (const [patch, why] of refused) expect(() => cfg(patch), JSON.stringify(patch)).toThrow(why);
    // every problem is reported at once
    expect(publicDemoProblems({ SS_AUTH_MODE: "demo", SS_LLM: "workers-ai", SS_RUNNER_TOKEN: "r" } as unknown as E).length).toBeGreaterThanOrEqual(4);
    // an empty value is not a token (local tests override .dev.vars this way)
    expect(() => cfg({ SS_RUNNER_TOKEN: "" })).not.toThrow();
  });

  it("leaves the other modes as they were", () => {
    expect(parseConfig({ SS_AUTH_MODE: "dev" } as unknown as E)).toMatchObject({ authMode: "dev", publicDemo: null, chatFallback: "message", recordedOn: "this laptop" });
    expect(parseConfig({ SS_DEMO: "1", SS_LLM: "mlx" } as unknown as E)).toMatchObject({ demo: true, llm: "recorded", publicDemo: null, chatFallback: "message" });
  });
});
