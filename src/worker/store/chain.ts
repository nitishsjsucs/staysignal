// Hash chains for the action log and the approval audit (SPEC 14.5): hash = sha256(prev_hash || canonical_json(row
// without hash)). Pattern copied from PeopleVault src/worker/audit/audit-log.ts (MIT). Verification recomputes every
// hash and compares each head with its latest anchor written outside the Durable Object (C25).
import { canonicalJson } from "../../shared/canonical-json";
import { sha256Hex } from "../../shared/sha256";

export function sha256HexSync(text: string): string {
  return sha256Hex(text);
}

export function chainHash(prevHash: string, row: Record<string, unknown>): string {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (k !== "hash" && v !== undefined) body[k] = v;
  return sha256HexSync(prevHash + canonicalJson(body));
}

export interface ChainCheck {
  ok: boolean;
  rows: number;
  head: { seq: number; hash: string } | null;
  firstBad: number | null;
}

export function verifyChain(rows: Record<string, unknown>[], genesis: string): ChainCheck {
  let prev = genesis;
  for (const row of rows) {
    if (row.prev_hash !== prev || chainHash(prev, row) !== row.hash) return { ok: false, rows: rows.length, head: null, firstBad: Number(row.seq) };
    prev = String(row.hash);
  }
  const last = rows[rows.length - 1];
  return { ok: true, rows: rows.length, head: last ? { seq: Number(last.seq), hash: String(last.hash) } : null, firstBad: null };
}
