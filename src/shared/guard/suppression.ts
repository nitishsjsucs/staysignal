// Hidden-sum suppression for breakdowns (SPEC 17.5 rule 1). Pattern from PeopleLens worker/src/guard/suppression.ts
// (MIT) rule 3: within a partition (the children of one parent), the people in hidden cells must number 0 or at least
// 10, otherwise the smallest visible cell is suppressed too, repeated to a fixed point. Cells under 10 are never
// published, so the hidden count is the parent's n minus the visible children's n.
import { MIN_CELL } from "../policy/authorize";

export interface Cell {
  key: string;
  n: number;
}

export function hiddenSumSuppress(parentN: number, visible: readonly Cell[]): { suppressed: Set<string>; hidden: number } {
  const suppressed = new Set<string>();
  const open = [...visible].sort((a, b) => a.n - b.n || (a.key < b.key ? -1 : 1));
  let hidden = parentN - visible.reduce((s, c) => s + c.n, 0);
  while (hidden > 0 && hidden < MIN_CELL && open.length > 0) {
    const next = open.shift() as Cell;
    suppressed.add(next.key);
    hidden += next.n;
  }
  return { suppressed, hidden };
}
