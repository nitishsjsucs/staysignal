import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/shared/canonical-json";
import { sha256Hex } from "../../src/shared/sha256";

describe("sha256 and canonical JSON", () => {
  it("matches node:crypto", () => {
    for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "naïve ✓ text", JSON.stringify({ x: [1, 2, 3] }).repeat(40)]) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });

  it("produces the engine's canonical JSON (sorted keys, ASCII escapes, integers only)", () => {
    expect(canonicalJson({ b: 1, a: ["x", null, true], c: "é" })).toBe('{"a":["x",null,true],"b":1,"c":"\\u00e9"}');
    expect(() => canonicalJson({ x: 1.5 })).toThrow();
  });
});
