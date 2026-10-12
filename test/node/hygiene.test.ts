import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decode, loadPrivateTerms } from "../../scripts/check-hygiene.ts";
import {
  checkFile,
  findDashes,
  findGitShas,
  findMonitoringTerms,
  findPersonNames,
  findPrivateTerms,
  findSecrets,
  parseDenylist,
} from "../../scripts/lib/hygiene.ts";
import { findProseViolations } from "../../scripts/lib/prose.ts";

// Planted hits are built at runtime so this file itself stays clean under both tiers and the operator's scan.
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PEM = ["-----BEGIN", " PRIVATE KEY-----\n", "A".repeat(80)].join("");
const TOKEN = ["gh", "p_", "x".repeat(30)].join("");

describe("public tier rules", () => {
  it("finds em and en dashes in any text", () => {
    expect(findDashes(`a ${EM} b\nc ${EN} d`).map((h) => h.line)).toEqual([1, 2]);
    expect(findDashes("a - b, 2023-04-01")).toEqual([]);
  });

  it("finds 40-hex git SHAs only in pinned paths", () => {
    expect(findGitShas(`sha ${SHA}`)).toHaveLength(1);
    expect(checkFile({ path: "data/world/manifest.json", text: `{"x":"${SHA}"}` }).map((h) => h.rule)).toEqual(["git-sha"]);
    expect(checkFile({ path: "src/worker/x.ts", text: `const x = "${SHA}";` })).toEqual([]);
    // 64-hex SHA-256 values are not git SHAs
    expect(findGitShas(`${SHA}${SHA.slice(0, 24)}`)).toEqual([]);
  });

  it("finds monitoring and special-category terms in generated text only", () => {
    expect(findMonitoringTerms("Personas discussed keystroke logging and a medical condition.")).toHaveLength(2);
    expect(checkFile({ path: "demo/recordings/beat1.jsonl", text: "they mention location tracking" }).map((h) => h.rule)).toEqual(["monitoring-term"]);
    expect(checkFile({ path: "docs/model-card.md", text: "No location tracking data is used." })).toEqual([]);
  });

  it("flags given name plus surname in generated text and in prose outside citations", () => {
    expect(findPersonNames("Ask Sarah Johnson about the review")).toHaveLength(1);
    expect(findPersonNames("Priya Raman wrote the post")).toHaveLength(1);
    expect(findPersonNames("Platform Engineering and Sales")).toEqual([]);
    expect(findPersonNames("Card, Mas, Moretti and Saez 2012 found", "x", { citationContext: true })).toEqual([]);
    expect(findPersonNames("Patrick Lewis said so", "x", { citationContext: true })).toHaveLength(1);
    expect(checkFile({ path: "LICENSE", text: "Copyright (c) 2026 Nitish Chowdary" })).toEqual([]);
  });

  it("finds private keys with key material and tokens, not a bare header", () => {
    expect(findSecrets(PEM).map((h) => h.rule)).toEqual(["secret"]);
    expect(findSecrets(TOKEN)).toHaveLength(1);
    expect(findSecrets("-----BEGIN PRIVATE KEY----- (header only)")).toEqual([]);
  });
});

describe("private tier", () => {
  it("parses the deny-list and withholds the matched term", () => {
    const terms = parseDenylist("# comment\n\nzebra project\nQuokkaTool\n");
    expect(terms).toEqual(["zebra project", "QuokkaTool"]);
    const hits = findPrivateTerms("the Zebra   Project and quokkatool here, but not quokkatools", terms);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.excerpt).not.toMatch(/zebra/i);
  });

  it("fails closed when SS_PRIVATE_DENYLIST is unset, inside the repository, or empty", () => {
    const root = process.cwd();
    expect(loadPrivateTerms(root, {})).toHaveProperty("error");
    expect(loadPrivateTerms(root, { SS_PRIVATE_DENYLIST: join(root, "package.json") })).toHaveProperty("error");
    const dir = mkdtempSync(join(tmpdir(), "ss-deny-"));
    writeFileSync(join(dir, "empty.txt"), "# nothing\n");
    expect(loadPrivateTerms(root, { SS_PRIVATE_DENYLIST: join(dir, "empty.txt") })).toHaveProperty("error");
    writeFileSync(join(dir, "list.txt"), "zebra project\n");
    expect(loadPrivateTerms(root, { SS_PRIVATE_DENYLIST: join(dir, "list.txt") })).toEqual({ terms: ["zebra project"] });
  });
});

describe("generated recordings are scanned decompressed", () => {
  it("gunzips Lab recordings and skips binaries", () => {
    const gz = gzipSync(Buffer.from('{"text":"we track keystroke counts"}\n'));
    const text = decode("lab/recordings/run1/calls.jsonl.gz", gz);
    expect(text).toContain("keystroke");
    expect(checkFile({ path: "lab/recordings/run1/calls.jsonl.gz", text: text ?? "" }).map((h) => h.rule)).toEqual(["monitoring-term"]);
    expect(decode("img.png", Buffer.from([0x89, 0x50, 0x00, 0x01]))).toBeNull();
  });
});

describe("prose rules", () => {
  it("flags dashes and banned phrasing outside code", () => {
    const md = `Fine text.\nA ${EM} dash.\nA seamless story.\n\`flight risk\` in code is fine.\n\`\`\`\nrevolutionary in a fence\n\`\`\``;
    expect(findProseViolations(md).map((v) => v.kind)).toEqual(["em-dash", "banned-phrase"]);
  });
});
