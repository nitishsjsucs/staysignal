// Request authentication (SPEC 4.3, 17.1). The principal ID is the Access `sub`, or `svc:` plus `common_name` for a
// service token (whose `sub` is empty). Roles come from policy/principals.local.json in dev mode and from the Worker
// secret SS_ROLE_BINDINGS in production. Any client-supplied x-ss-principal header is stripped; the Worker sets it
// only after verification, for the Durable Objects behind it.
import { localPrincipal, type Principal, principalFor, type Role } from "../../shared/policy/roles";
import { type AppConfig, isLocalHost } from "../config";
import { ACCESS_HEADER, AuthError, verifyAccessJwt } from "./access";

export const PRINCIPAL_HEADER = "x-ss-principal";
export const DEV_COOKIE = "ss_dev";

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("Cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** The Access assertion: the header in production; in dev mode on localhost also a bearer token or the dev cookie. */
export function tokenFrom(request: Request, config: AppConfig): string | null {
  const header = request.headers.get(ACCESS_HEADER);
  if (header) return header;
  if (config.authMode !== "dev" || !isLocalHost(new URL(request.url))) return null;
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const url = new URL(request.url);
  return readCookie(request, DEV_COOKIE) ?? url.searchParams.get("ss_token");
}

export function principalId(payload: { sub?: unknown; common_name?: unknown; email?: unknown }): string {
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (sub) return sub;
  if (typeof payload.common_name === "string" && payload.common_name) return `svc:${payload.common_name}`;
  throw new AuthError("invalid", "token has neither sub nor common_name");
}

/** The runner's principal ID: a service token's ID is svc: plus the JWT's common_name, which Access sets to the token's
 * client ID in production (SS_RUNNER_TOKEN_ID); dev tokens are minted with the token's name. */
export function runnerId(config: AppConfig): string {
  return config.authMode === "dev" ? "svc:staysignal-runner" : `svc:${config.serviceTokens.runner ?? "unset"}`;
}

export function mcpId(config: AppConfig): string {
  return config.authMode === "dev" ? "svc:staysignal-mcp" : `svc:${config.serviceTokens.mcp ?? "unset"}`;
}

export function bindRole(config: AppConfig, id: string): Principal | null {
  if (config.authMode === "dev") {
    const local = localPrincipal(id);
    if (local) return local;
  }
  if (id === runnerId(config) && (config.authMode === "dev" || config.serviceTokens.runner)) return principalFor(id, "data_engineer", [], "Runner service");
  if (id === mcpId(config) && (config.authMode === "dev" || config.serviceTokens.mcp)) return principalFor(id, "people_analyst", [], "MCP client");
  if (config.authMode === "dev") return null;
  if (!config.roleBindings) return null;
  const bindings = JSON.parse(config.roleBindings) as Record<string, { role: Role; assigned_orgs?: string[]; display?: string }>;
  const b = bindings[id];
  return b ? principalFor(id, b.role, b.assigned_orgs ?? [], b.display) : null;
}

export async function authenticate(request: Request, config: AppConfig): Promise<Principal> {
  const payload = await verifyAccessJwt(tokenFrom(request, config), config);
  const id = principalId(payload);
  const p = bindRole(config, id);
  if (!p) throw new AuthError("unknown_principal", "no role is bound to this principal");
  return p;
}

/** Copy of the request with the verified principal in the internal header (client copies are dropped). */
export function withPrincipal(request: Request, p: Principal): Request {
  const headers = new Headers(request.headers);
  headers.delete(PRINCIPAL_HEADER);
  headers.set(PRINCIPAL_HEADER, JSON.stringify(p));
  return new Request(request, { headers });
}

export function stripPrincipal(request: Request): Request {
  if (!request.headers.has(PRINCIPAL_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(PRINCIPAL_HEADER);
  return new Request(request, { headers });
}
