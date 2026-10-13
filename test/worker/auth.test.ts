// C50, C75: every request is authenticated; spoofed principal headers are ignored; service-token principals are svc:.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { mintDevToken } from "../../src/worker/auth/dev-login";
import { bindRole, principalId } from "../../src/worker/auth/principal";
import { parseConfig } from "../../src/worker/config";
import { call, P } from "../helpers/api";

describe("authentication", () => {
  it("refuses a missing, invalid or expired token", async () => {
    expect((await call("/api/runs")).status).toBe(401);
    expect((await call("/api/runs", { headers: { Authorization: "Bearer not-a-jwt" } })).status).toBe(401);
    const cfg = parseConfig(env);
    const expired = await mintDevToken(cfg, P.analyst, -10);
    const r = await call("/api/runs", { headers: { Authorization: `Bearer ${expired}` } });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ reason: "expired" });
  });

  it("ignores a client-supplied principal header", async () => {
    const spoof = JSON.stringify({ id: P.lead, role: "pa_lead", scopes: ["rollback"], assignedOrgs: [], kind: "human", display: "x" });
    expect((await call("/api/runs", { headers: { "x-ss-principal": spoof } })).status).toBe(401);
    const me = (await (await call("/api/me", { as: P.auditor, headers: { "x-ss-principal": spoof } })).json()) as { principal: { id: string } };
    expect(me.principal.id).toBe(P.auditor);
  });

  it("maps a service token's empty sub to svc: plus common_name", () => {
    expect(principalId({ sub: "", common_name: "staysignal-runner" })).toBe("svc:staysignal-runner");
    expect(principalId({ sub: P.analyst })).toBe(P.analyst);
    expect(() => principalId({ sub: "" })).toThrow();
  });

  it("binds production service tokens by their client ID, the common_name Access puts in their JWT", () => {
    const prod = { ...parseConfig(env), authMode: "access" as const, roleBindings: "{}", serviceTokens: { runner: "abc123.access", mcp: "def456.access" } };
    expect(bindRole(prod, "svc:abc123.access")?.role).toBe("data_engineer");
    expect(bindRole(prod, "svc:def456.access")?.role).toBe("people_analyst");
    // the token's display name is not its common_name in production
    expect(bindRole(prod, "svc:staysignal-runner")).toBeNull();
    // without the secrets nothing is bound, not even a token whose common_name is the literal "unset"
    const bare = { ...prod, serviceTokens: { runner: null, mcp: null } };
    expect(bindRole(bare, "svc:abc123.access")).toBeNull();
    expect(bindRole(bare, "svc:unset")).toBeNull();
  });

  it("lets the runner service token use the internal protocol and nobody else", async () => {
    const cfg = parseConfig(env);
    const svc = await mintDevToken(cfg, "svc:staysignal-runner");
    const ok = await exports.default.fetch(new Request("http://localhost/internal/runner/lease", { method: "POST", headers: { Authorization: `Bearer ${svc}`, "content-type": "application/json" }, body: "{}" }));
    expect(ok.status).toBe(200);
    const human = await call("/internal/runner/lease", { as: P.analyst, body: {} });
    expect(human.status).toBe(401);
  });
});
