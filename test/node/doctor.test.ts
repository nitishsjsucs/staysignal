// SPEC 23.3: the doctor only runs read commands, parses what it reads, and reports each gap with its fix.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowed, billingEnabled, cloudflareChecks, dfFreeKb, type Exec, gcpChecks, secretChecks, summary, versionAtLeast, whoamiLoggedIn } from "../../scripts/doctor.ts";

const fake = (answers: Record<string, string | null>): Exec => (argv) => {
  const key = Object.keys(answers).find((k) => argv.join(" ").startsWith(k));
  const out = key === undefined ? null : answers[key]!;
  return out === null ? { ok: false, out: "" } : { ok: true, out };
};

describe("doctor", () => {
  it("allows read commands only", () => {
    expect(allowed(["npx", "wrangler", "whoami"])).toBe(true);
    expect(allowed(["gcloud", "billing", "projects", "describe", "p", "--format=json"])).toBe(true);
    for (const bad of [["npx", "wrangler", "deploy"], ["npx", "wrangler", "secret", "put", "X"], ["gcloud", "services", "enable", "x"], ["bq", "mk", "d"], ["rm", "-rf", "x"]]) expect(allowed(bad)).toBe(false);
  });

  it("parses versions, free disk, login and billing", () => {
    expect(versionAtLeast("v25.9.0", "24.0.0")).toBe(true);
    expect(versionAtLeast("4.148.9", "4.149.0")).toBe(false);
    expect(dfFreeKb("Filesystem 1024-blocks Used Available Capacity\n/dev/disk3s5 482344960 403701816 32505744 93% /System")).toBe(32505744);
    expect(whoamiLoggedIn("You are logged in with an OAuth Token... Account Name | Account ID")).toBe(true);
    expect(whoamiLoggedIn("You are not authenticated. Please run wrangler login.")).toBe(false);
    expect(billingEnabled('{"billingEnabled": false}')).toBe(false);
    expect(billingEnabled("not json")).toBeNull();
  });

  it("reports the Cloudflare and Google gaps with their fixes and never prints identifiers", () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-"));
    const cf = cloudflareChecks(fake({ "npx wrangler whoami": "You are logged in. Account ID abc123", "npx wrangler ai models list": '[{"name":"@cf/qwen/qwen3-30b-a3b-fp8"}]' }), root);
    expect(cf.find((c) => c.name === "wrangler logged in")?.status).toBe("PASS");
    expect(cf.find((c) => c.name.startsWith("Workers AI model"))?.status).toBe("PASS");
    expect(cf.find((c) => c.name.startsWith("Access application"))?.status).toBe("MISSING");
    expect(JSON.stringify(cf)).not.toContain("abc123");
    process.env.SS_GCP_PROJECT = "proj-123";
    const gcp = gcpChecks(fake({ "gcloud --version": "Google Cloud SDK", "gcloud config get-value account": "someone@example.com", "gcloud billing projects describe": '{"billingEnabled": false}', "gcloud services list": "bigquery.googleapis.com", "bq ls": "[]" }));
    delete process.env.SS_GCP_PROJECT;
    expect(gcp.find((c) => c.name === "billing enabled")).toMatchObject({ status: "FAIL" });
    expect(gcp.find((c) => c.name === "BigQuery API enabled")?.status).toBe("PASS");
    expect(gcp.find((c) => c.name === "staysignal_* datasets")).toMatchObject({ status: "MISSING", detail: "7 of 7 missing" });
    expect(JSON.stringify(gcp)).not.toMatch(/proj-123|someone@example\.com/);
  });

  it("checks secret names, never values, and groups the gaps by fix", () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-"));
    mkdirSync(join(root, ".secrets"));
    writeFileSync(join(root, ".secrets", "staysignal.env"), "CF_SETUP_TOKEN=secret-value\n# comment\nSS_HMAC_MASTER_KEY=x\n");
    const s = secretChecks(root);
    expect(s.filter((c) => c.status === "PASS").map((c) => c.name)).toEqual(["CF_SETUP_TOKEN", "SS_HMAC_MASTER_KEY"]);
    expect(JSON.stringify(s)).not.toContain("secret-value");
    const lines = summary(s);
    expect(lines[0]).toBe("4 checks: 2 pass, 2 missing");
    expect(lines.join("\n")).toContain("SS_AIG_TOKEN (MISSING)");
  });
});
