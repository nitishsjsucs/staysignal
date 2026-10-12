// The synthetic clock (SPEC 6.1, C69). Every user-visible timestamp is the demo clock plus elapsed real time since
// the demo epoch started, never the wall clock.
export const DEMO_CLOCK_ISO = "2026-10-05T14:00:00Z";
export const DEMO_CLOCK_MS = Date.parse(DEMO_CLOCK_ISO);

/** Synthetic time for a real instant, given the real instant at which the current demo epoch began. */
export function syntheticNow(realNowMs: number, epochRealStartMs: number): string {
  const elapsed = Math.max(0, realNowMs - epochRealStartMs);
  return new Date(DEMO_CLOCK_MS + elapsed).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC`;
}
