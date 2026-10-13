// The production memory's write rules (src/shared/memory/write.ts), the same as the engine's write_note: note IDs,
// the timeline pointer, write-order bullets, idempotent writes, the engine's file format, and refusals.
import { describe, expect, it } from "vitest";
import { appendBullets, NoteRejected, parseDoc, renderDoc, writeNote } from "../../src/shared/memory/write";

const SEED = {
  "investigations/INV-2026-10-12-01.md": renderDoc({ meta: { id: "INV-2026-10-12-01", type: "investigation", aliases: [], links: ["timeline/daily/2026-10-12"] }, title: "Earlier", bullets: [["2026-10-12", "x"]] }),
};

describe("memory writes without git", () => {
  it("renders the engine's format and parses it back", () => {
    const text = renderDoc({ meta: { id: "DEC-2026-10-12-01", type: "decision", aliases: ["approval", "mapping"], links: ["timeline/daily/2026-10-12"] }, title: "Payroll mapping payroll@2 activated", bullets: [["2026-10-12", "A Data Engineer approved it (action 9)."]] });
    expect(text).toBe("---\naliases: [approval, mapping]\nid: DEC-2026-10-12-01\nlinks: [timeline/daily/2026-10-12]\ntype: decision\n---\n# Payroll mapping payroll@2 activated\n\n- 2026-10-12: A Data Engineer approved it (action 9).\n");
    expect(renderDoc(parseDoc(text))).toBe(text);
  });

  it("numbers notes, points the timeline at them and keeps write order", () => {
    const r = writeNote(SEED, { kind: "investigation", title: "Run held by checks C01, C02", bullets: ["first", "second"] }, "2026-10-12T06:30:00Z");
    expect(r.id).toBe("INV-2026-10-12-02");
    expect(Object.keys(r.changed).sort()).toEqual(["investigations/INV-2026-10-12-02.md", "timeline/daily/2026-10-12.md"]);
    expect(parseDoc(r.changed["investigations/INV-2026-10-12-02.md"]!).bullets.map((b) => b[1])).toEqual(["first", "second"]);
    expect(parseDoc(r.changed["timeline/daily/2026-10-12.md"]!).bullets).toEqual([["2026-10-12", "INV-2026-10-12-02: Run held by checks C01, C02"]]);
    expect(r.message).toBe("memory: investigation INV-2026-10-12-02");
    const files = { ...SEED, ...r.changed };
    expect(writeNote(files, { kind: "investigation", id: "INV-2026-10-12-02", title: "Run held by checks C01, C02", bullets: ["first"] }, "2026-10-12T07:00:00Z").changed).toEqual({});
    expect(appendBullets([["2026-10-12", "b"]], [["2026-10-11", "z"], ["2026-10-12", "a"]])).toEqual([["2026-10-11", "z"], ["2026-10-12", "b"], ["2026-10-12", "a"]]);
  });

  it("refuses people, bad links, bad IDs and empty notes", () => {
    const at = "2026-10-12T06:30:00Z";
    for (const note of [
      { kind: "timeline" as const, bullets: ["E104233 left."] },
      { kind: "timeline" as const, bullets: ["Ask a.person@gmail.com."] },
      { kind: "decision" as const, title: "x", bullets: ["y"], links: ["../../etc/passwd"] },
      { kind: "decision" as const, id: "INV-2026-10-12-01", title: "x", bullets: ["y"] },
      { kind: "timeline" as const, bullets: [] },
    ]) expect(() => writeNote(SEED, note, at)).toThrow(NoteRejected);
  });
});
