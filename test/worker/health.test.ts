import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("worker health", () => {
  it("answers /api/health with the synthetic label", async () => {
    const res = await exports.default.fetch(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "staysignal", label: "synthetic" });
  });
});
