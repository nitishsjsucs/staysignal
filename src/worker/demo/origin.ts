// The public demo's same-origin rule (ADR 0018): a request another site starts never reaches a sandbox. A browser
// names where a request comes from in Origin (every WebSocket upgrade, every write, every cross-origin fetch) and in
// Sec-Fetch-Site (every request, in current browsers). Other Workers on the operator's account share its workers.dev
// subdomain and so are the same site as the demo: a SameSite cookie goes with their pages' requests too. So the rule
// is this exact origin (scheme, host and port), not this site. A request with neither header is not a browser's, and
// carries only its sender's own cookie.

/** True when a browser says another origin or another site started this request. */
export function fromAnotherSite(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site === "cross-site" || site === "same-site") return true;
  const origin = request.headers.get("Origin");
  if (origin === null) return false;
  try {
    return new URL(origin).origin !== new URL(request.url).origin;
  } catch {
    // "null" (a sandboxed frame, a file) or anything that is not an origin
    return true;
  }
}

export const CROSS_ORIGIN_MESSAGE = "cross-origin request refused";
