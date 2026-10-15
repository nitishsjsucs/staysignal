// C42: the deployment configuration uses only Workers Free features and StaySignal's deployment rules; the deploy
// script renders the fixtures template with placeholders in a dry run and refuses without the operator's state.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { DEMO_TEMPLATE, PRODUCTION_TEMPLATE, render, TEMPLATE } from "../../scripts/deploy.ts";
import { freePlanProblems } from "../../scripts/lib/free-plan.ts";
import { parseJsonc, stripJsonc } from "../../scripts/lib/jsonc.ts";

describe("Workers Free rules for deployments", () => {
  it("accept the rendered fixtures template", () => {
    const text = render(true);
    expect(freePlanProblems(text)).toEqual([]);
    const c = parseJsonc<{ vars: Record<string, string>; migrations: { new_sqlite_classes: string[] }[] }>(text);
    expect(c.vars.SS_DATA_MODE).toBe("fixtures");
    expect(c.vars.SS_RUNNER).toBe("inline");
    expect(c.vars.SS_AUTH_MODE).toBe("access");
    expect(c.migrations[0]!.new_sqlite_classes).toEqual(["AnalystAgent", "WorkspaceAgent"]);
    // the production model through AI Gateway, with a cap and its token as a secret (SPEC 14.11)
    expect(c.vars.SS_LLM).toBe("workers-ai");
    expect(c.vars.SS_AI_MODEL).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
    expect(Number(c.vars.SS_AI_DAILY_NEURON_CAP)).toBe(1500);
  });

  it("require the gateway, a cap within the free allowance and the token as a secret for Workers AI", () => {
    const base = JSON.parse(stripJsonc(render(true))) as { vars: Record<string, string>; secrets: { required: string[] } };
    const problems = (patch: Record<string, unknown>) => freePlanProblems(JSON.stringify({ ...base, ...patch })).join(" ");
    expect(problems({ vars: { ...base.vars, SS_AIG_GATEWAY_ID: "" } })).toMatch(/AI Gateway/);
    expect(problems({ vars: { ...base.vars, SS_AI_DAILY_NEURON_CAP: "20000" } })).toMatch(/10,000 free neurons/);
    expect(problems({ secrets: { required: ["SS_HMAC_MASTER_KEY"] } })).toMatch(/SS_AIG_TOKEN/);
    expect(problems({ vars: { ...base.vars, SS_AI_MODEL: "@cf/qwen/qwen3.8-27b" } })).toMatch(/not the production model/);
  });

  it("refuse Paid features, key-value Durable Objects, dev auth, local models and secrets in vars", () => {
    const base = JSON.parse(stripJsonc(render(true))) as Record<string, unknown>;
    const problems = (patch: Record<string, unknown>) => freePlanProblems(JSON.stringify({ ...base, ...patch }));
    expect(problems({ pipelines: [{}] })[0]).toMatch(/Workers Paid/);
    expect(problems({ limits: { cpu_ms: 50 } })[0]).toMatch(/Workers Paid/);
    expect(problems({ tail_consumers: [{ service: "x" }] })[0]).toMatch(/Workers Paid/);
    expect(problems({ migrations: [{ tag: "v1", new_classes: ["AnalystAgent", "WorkspaceAgent"] }] }).join(" ")).toMatch(/SQLite class/);
    const vars = base.vars as Record<string, string>;
    expect(problems({ vars: { ...vars, SS_AUTH_MODE: "dev" } }).join(" ")).toMatch(/access/);
    expect(problems({ vars: { ...vars, SS_LLM: "mlx" } }).join(" ")).toMatch(/local model/);
    expect(problems({ vars: { ...vars, SS_RUNNER_TOKEN: "x" } }).join(" ")).toMatch(/secret/);
    expect(problems({ ai: { binding: "AI" }, vars: { ...vars, SS_LLM: "stub" } }).join(" ")).toMatch(/ai binding/);
  });

  it("accept the production template: BigQuery with the service account key as a secret and the runner", () => {
    const text = render(true, join(process.cwd(), ".prod", "nonexistent.json"), PRODUCTION_TEMPLATE);
    expect(freePlanProblems(text)).toEqual([]);
    const c = parseJsonc<{ vars: Record<string, string>; secrets: { required: string[] } }>(text);
    expect(c.vars).toMatchObject({ SS_DATA_MODE: "bigquery", SS_GCP_PROJECT_ID: "dry-run-project", SS_RUNNER: "external", SS_LLM: "workers-ai" });
    expect(c.secrets.required).toEqual(expect.arrayContaining(["SS_GCP_SA_KEY", "SS_RUNNER_TOKEN", "SS_AIG_TOKEN"]));
    const base = JSON.parse(stripJsonc(text)) as { vars: Record<string, string>; secrets: { required: string[] } };
    const problems = (patch: Record<string, unknown>) => freePlanProblems(JSON.stringify({ ...base, ...patch })).join(" ");
    expect(problems({ vars: { ...base.vars, SS_GCP_PROJECT_ID: "" } })).toMatch(/SS_GCP_PROJECT_ID/);
    expect(problems({ secrets: { required: ["SS_AIG_TOKEN"] } })).toMatch(/SS_GCP_SA_KEY/);
    expect(problems({ vars: { ...base.vars, SS_RUNNER: "inline" } })).toMatch(/needs the runner/);
  });

  it("accept the public demo template: its own sign-in, the signing key as a secret, the gate, no real data path (ADR 0018)", () => {
    for (const dry of [true, false]) {
      const text = render(dry, "/nonexistent/state.json", DEMO_TEMPLATE);
      expect(freePlanProblems(text)).toEqual([]);
    }
    const c = parseJsonc<{ name: string; workers_dev: boolean; ai?: unknown; vars: Record<string, string>; secrets: { required: string[] }; durable_objects: { bindings: { name: string; class_name: string }[] }; migrations: { tag: string; new_sqlite_classes: string[] }[]; workflows: { name: string }[] }>(render(true, "/nonexistent/state.json", DEMO_TEMPLATE));
    expect(c.name).toBe("staysignal-demo");
    expect(c.workers_dev).toBe(true);
    expect(c.ai).toBeUndefined();
    expect(c.vars).toEqual({ SS_AUTH_MODE: "demo", SS_PUBLIC_DEMO: "1", SS_DATA_MODE: "fixtures", SS_RUNNER: "inline", SS_LLM: "recorded", SS_DEMO: "1" });
    expect(c.secrets.required).toEqual(["SS_DEMO_SIGNING_KEY"]);
    expect(c.durable_objects.bindings.map((b) => b.class_name)).toEqual(["AnalystAgent", "WorkspaceAgent", "DemoGate"]);
    expect(c.migrations.flatMap((m) => m.new_sqlite_classes)).toEqual(["AnalystAgent", "WorkspaceAgent", "DemoGate"]);
    expect(c.workflows.map((w) => w.name)).toEqual(["staysignal-demo-routine"]);
  });

  it("refuse a public demo with Workers AI, BigQuery, Access, tokens, a missing key or gate, or a shared Workflow name", () => {
    const base = JSON.parse(stripJsonc(render(true, "/nonexistent/state.json", DEMO_TEMPLATE))) as { vars: Record<string, string>; secrets: { required: string[] }; durable_objects: { bindings: unknown[] } } & Record<string, unknown>;
    const problems = (patch: Record<string, unknown>) => freePlanProblems(JSON.stringify({ ...base, ...patch })).join(" ");
    expect(problems({ ai: { binding: "AI" } })).toMatch(/never calls Workers AI/);
    expect(problems({ vars: { ...base.vars, SS_LLM: "workers-ai" } })).toMatch(/never calls a live model/);
    expect(problems({ vars: { ...base.vars, SS_AIG_GATEWAY_ID: "staysignal" } })).toMatch(/never uses SS_AIG_GATEWAY_ID/);
    expect(problems({ vars: { ...base.vars, SS_DATA_MODE: "bigquery", SS_GCP_PROJECT_ID: "p" } })).toMatch(/committed fixtures/);
    expect(problems({ vars: { ...base.vars, SS_ACCESS_AUD: "a" } })).toMatch(/never uses SS_ACCESS_AUD/);
    expect(problems({ vars: { ...base.vars, SS_RUNNER: "external" } })).toMatch(/no runner/);
    expect(problems({ vars: { ...base.vars, SS_PUBLIC_DEMO: "0" } })).toMatch(/SS_PUBLIC_DEMO=1/);
    expect(problems({ vars: { ...base.vars, SS_DEMO_SIGNING_KEY: "x" } })).toMatch(/looks like a secret/);
    expect(problems({ secrets: { required: [] } })).toMatch(/SS_DEMO_SIGNING_KEY/);
    expect(problems({ secrets: { required: ["SS_DEMO_SIGNING_KEY", "SS_AIG_TOKEN"] } })).toMatch(/never needs the secret SS_AIG_TOKEN/);
    expect(problems({ durable_objects: { bindings: [{ name: "ANALYST_AGENT", class_name: "AnalystAgent" }, { name: "WORKSPACE_AGENT", class_name: "WorkspaceAgent" }] } })).toMatch(/DEMO_GATE/);
    expect(problems({ workers_dev: false })).toMatch(/workers.dev/);
    expect(problems({ workflows: [{ name: "staysignal-routine", binding: "ROUTINE_WORKFLOW", class_name: "RoutineWorkflow" }] })).toMatch(/account-wide/);
    expect(problems({ observability: { enabled: true, head_sampling_rate: 1 } })).toMatch(/head_sampling_rate <= 0.1/);
    expect(problems({ observability: { enabled: true } })).toMatch(/head_sampling_rate <= 0.1/);
    expect(problems({ observability: { enabled: false } })).not.toMatch(/head_sampling_rate/);
  });

  it("render placeholders only in a dry run and keep URLs inside strings", () => {
    expect(render(true)).toContain("https://example-team.cloudflareaccess.com");
    expect(() => render(false, "/nonexistent/state.json")).toThrow(/Production setup/);
    expect(readFileSync(TEMPLATE, "utf8")).toContain("__SS_ACCESS_AUD__");
    expect(stripJsonc('{"a": "https://x.example/y", // c\n "b": [1, 2,],}')).toBe('{"a": "https://x.example/y", \n "b": [1, 2]}');
  });
});
