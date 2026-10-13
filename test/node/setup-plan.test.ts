// Grant and bootstrap plans (SPEC 17.2, 23.2): the committed grant plan obeys the shared-project rules, and the setup
// plan creates only what is missing, never deletes, and blocks phase B while billing is disabled. setup:prod reads
// through the doctor's read-only allowlist and runs nothing.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allowed } from "../../scripts/doctor.ts";
import { type GrantPlan, type Observed, planA, planB } from "../../scripts/lib/setup-plan.ts";
import { observe } from "../../scripts/setup-prod.ts";

const g = JSON.parse(readFileSync("infra/gcp/grants.json", "utf8")) as GrantPlan;
const nothing: Observed = { projectId: "proj-x", billingEnabled: false, datasets: [], serviceAccounts: [], projectRoles: [], r2Buckets: [], workerSecrets: [], aiGateway: false, access: false, serviceTokens: false };

describe("the grant plan", () => {
  it("keeps every name under the prefix, grants per dataset and only Job User on the project", () => {
    expect(g.datasets.every((d) => d.dataset.startsWith("staysignal_"))).toBe(true);
    expect(g.service_accounts.map((s) => s.account).sort()).toEqual(["staysignal-runner", "staysignal-worker"]);
    expect(new Set(g.project_roles.map((r) => r.role))).toEqual(new Set(["roles/bigquery.jobUser"]));
    expect(g.dataset_grants.every((x) => g.datasets.some((d) => d.dataset === x.dataset))).toBe(true);
    const worker = g.dataset_grants.filter((x) => x.member.includes("staysignal-worker@"));
    expect(worker.map((x) => x.dataset).sort()).toEqual(["staysignal_lab", "staysignal_published", "staysignal_semantic"]);
    expect(worker.every((x) => x.role === "roles/bigquery.dataViewer")).toBe(true);
    expect(g.authorized_views).toEqual([{ dataset: "staysignal_audit", view: "v_action_audit_aggregates", reader: expect.stringContaining("staysignal-worker@") }]);
    expect(g.jobs["staysignal-worker"]).toEqual({ maximum_bytes_billed: 104857600, labels: { app: "staysignal" } });
    expect(g.jobs["staysignal-runner"]!.maximum_bytes_billed).toBe(1073741824);
    // the project ID never appears in a committed file
    expect(JSON.stringify(g)).not.toMatch(/master-magnet|\d{6}-[a-z0-9]{2}\b/);
    expect(g.dataset_grants.every((x) => x.member.endsWith("@<PROJECT_ID>.iam.gserviceaccount.com"))).toBe(true);
  });
});

describe("the setup plan", () => {
  it("blocks phase B while billing is disabled and creates only what is missing once it is enabled", () => {
    const blocked = planB(g, nothing);
    expect(blocked.find((s) => s.id === "billing")?.status).toBe("todo");
    expect(blocked.filter((s) => s.id !== "billing").every((s) => s.status === "blocked")).toBe(true);
    const some: Observed = { ...nothing, billingEnabled: true, datasets: ["staysignal_raw", "other_repo_dataset"], serviceAccounts: ["staysignal-worker"] };
    const steps = planB(g, some);
    expect(steps.find((s) => s.id === "dataset-staysignal_raw")?.status).toBe("done");
    expect(steps.find((s) => s.id === "dataset-staysignal_lab")).toMatchObject({ status: "todo", how: "bq --location=US mk --dataset --description \"Scenario Lab recordings and cohort cells\" proj-x:staysignal_lab" });
    expect(steps.find((s) => s.id === "sa-staysignal-worker")?.status).toBe("done");
    expect(steps.filter((s) => s.id.startsWith("project-role-")).every((s) => s.how.includes("roles/bigquery.jobUser"))).toBe(true);
    for (const s of [...steps, ...planA(nothing)]) expect(s.how).not.toMatch(/\b(delete|rm|remove-iam-policy-binding|destroy)\b/);
  });

  it("marks phase A steps done from state and the secret list", () => {
    const a = planA({ ...nothing, r2Buckets: ["staysignal-landing"], workerSecrets: ["SS_HMAC_MASTER_KEY"], aiGateway: true });
    expect(Object.fromEntries(a.map((s) => [s.id, s.status]))).toMatchObject({ "r2-bucket": "done", "ai-gateway": "done", "access-app": "todo", "secret-SS_HMAC_MASTER_KEY": "done", "secret-SS_AIG_TOKEN": "todo" });
  });

  it("observes through read-only commands only", () => {
    const seen: string[][] = [];
    const exec = (argv: string[]) => {
      seen.push(argv);
      expect(allowed(argv)).toBe(true);
      if (argv[0] === "gcloud" && argv[1] === "config") return { ok: true, out: "proj-x\n" };
      if (argv[0] === "bq") return { ok: true, out: JSON.stringify([{ datasetReference: { datasetId: "staysignal_raw" } }]) };
      if (argv.includes("service-accounts")) return { ok: true, out: "staysignal-worker@proj-x.iam.gserviceaccount.com\n" };
      if (argv.includes("bucket")) return { ok: true, out: "name: staysignal-landing\ncreation_date: x\n" };
      return { ok: false, out: "" };
    };
    const o = observe(exec, { ai_gateway: { id: "staysignal" } });
    expect(o).toMatchObject({ projectId: "proj-x", datasets: ["staysignal_raw"], serviceAccounts: ["staysignal-worker"], r2Buckets: ["staysignal-landing"], aiGateway: true, billingEnabled: null });
    expect(seen.length).toBeGreaterThan(5);
    expect(allowed(["npx", "wrangler", "r2", "bucket", "create", "x"])).toBe(false);
    expect(allowed(["gcloud", "projects", "add-iam-policy-binding", "x"])).toBe(false);
  });
});
