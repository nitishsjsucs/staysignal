import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scaffold", () => {
  it("pins Node 24 and exact dependency versions", () => {
    expect(readFileSync(".nvmrc", "utf8").trim()).toBe("24");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
