// Number formatting shared by the grounding renderer and the UI. Formats are the placeholder formats of SPEC 14.4.
export type Fmt = "int" | "1dp" | "pct" | "range" | "raw";

export function fmtNumber(v: number, fmt: Fmt, step?: number): string {
  if (!Number.isFinite(v)) return "n/a";
  switch (fmt) {
    case "int":
      return Math.round(v).toLocaleString("en-US");
    case "1dp":
      return (Math.round(v * 10) / 10).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    case "pct":
      return `${(Math.round(v * 1000) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
    default:
      if (step !== undefined) {
        const digits = step >= 1 ? 0 : 1;
        return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
      }
      return String(v);
  }
}

export function fmtRange(r: readonly [number, number]): string {
  return `${Math.round(r[0])} to ${Math.round(r[1])}`;
}

/** A value rounded by its cohort step, shown with the precision the step allows. */
export function fmtStep(v: number, step: number): string {
  return fmtNumber(v, "raw", step);
}
