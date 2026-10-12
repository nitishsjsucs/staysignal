// The amd64 Playwright container runner (SPEC 16.4): the pinned image, no local secrets or state copied in, and
// baselines written only with --update.
import { describe, expect, it } from "vitest";
import { CONTAINER, containerScript, IMAGE } from "../../scripts/e2e-container.ts";

describe("e2e container", () => {
  it("uses the pinned image and a staysignal-* name", () => {
    expect(IMAGE).toBe("mcr.microsoft.com/playwright:v1.63.0-noble");
    expect(CONTAINER.startsWith("staysignal-")).toBe(true);
  });

  it("copies the repository without local secrets, state or host binaries", () => {
    const s = containerScript(false);
    for (const x of ["./node_modules", "./.dev.vars", "./.secrets", "./var", "./dist", "./.wrangler", "./engine/.venv"]) expect(s).toContain(`--exclude=${x}`);
    expect(s).toContain("SS_E2E_SCREENSHOTS=1");
    expect(s).not.toContain("--update-snapshots");
    expect(containerScript(true)).toContain("--update-snapshots");
  });
});
