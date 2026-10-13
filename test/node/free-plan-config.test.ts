// C42: the deployment configuration uses only Workers Free features and StaySignal's deployment rules; the deploy
// script renders the fixtures template with placeholders in a dry run and refuses without the operator's state.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { render, TEMPLATE } from "../../scripts/deploy.ts";
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
    expect(problems({ ai: { binding: "AI" } }).join(" ")).toMatch(/ai binding/);
  });

  it("render placeholders only in a dry run and keep URLs inside strings", () => {
    expect(render(true)).toContain("https://example-team.cloudflareaccess.com");
    expect(() => render(false, "/nonexistent/state.json")).toThrow(/setup:prod/);
    expect(readFileSync(TEMPLATE, "utf8")).toContain("__SS_ACCESS_AUD__");
    expect(stripJsonc('{"a": "https://x.example/y", // c\n "b": [1, 2,],}')).toBe('{"a": "https://x.example/y", \n "b": [1, 2]}');
  });
});
