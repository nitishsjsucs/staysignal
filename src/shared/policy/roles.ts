// Roles, scopes and principals (SPEC 14.1). The JSON files under policy/ are the single source.
import principalsJson from "../../../policy/principals.local.json";
import rolesJson from "../../../policy/roles.json";

export type Role = "people_analyst" | "people_partner" | "pa_lead" | "data_engineer" | "auditor" | "agent";
export type Scope = string;

export interface Principal {
  id: string;
  role: Role;
  scopes: Scope[];
  assignedOrgs: string[];
  kind: "human" | "agent" | "service";
  display: string;
  /** The public demo only (ADR 0018): the visitor's sandbox and its expiry (seconds since the epoch). Every piece of
   * mutable state is keyed by it; it is set by the Worker after verifying the session cookie, never by a client. */
  sandbox?: { id: string; exp: number };
}

export const ROLES = rolesJson.roles as Record<Role, { label: string; scopes: Scope[]; notes: string }>;

export const LOCAL_PRINCIPALS = principalsJson.principals as { id: string; role: Role; display: string; assigned_orgs?: string[] }[];

export const AGENT_PRINCIPAL_ID = "agent:staysignal";

export function principalFor(id: string, role: Role, assignedOrgs: string[] = [], display?: string): Principal {
  const kind: Principal["kind"] = role === "agent" ? "agent" : id.startsWith("svc:") ? "service" : "human";
  return { id, role, scopes: [...ROLES[role].scopes], assignedOrgs, kind, display: display ?? ROLES[role].label };
}

export function localPrincipal(id: string): Principal | null {
  const p = LOCAL_PRINCIPALS.find((x) => x.id === id);
  return p ? principalFor(p.id, p.role, p.assigned_orgs ?? [], p.display) : null;
}

export function agentPrincipal(): Principal {
  return principalFor(AGENT_PRINCIPAL_ID, "agent", [], "StaySignal agent");
}

export function hasScope(p: Principal, scope: Scope): boolean {
  return p.scopes.includes(scope);
}

export function hasAnyScope(p: Principal, prefix: string): boolean {
  return p.scopes.some((s) => s === prefix || s.startsWith(`${prefix}:`));
}

/** Principals with no action scopes get read-only connections (SPEC 14.5). */
export function isReadOnly(p: Principal): boolean {
  const actions = ["review:propose", "review:propose:assigned", "review:approve", "publish:approve", "mapping:approve", "rollback", "replay:run", "break_glass", "investigate:run", "lab:run"];
  return !p.scopes.some((s) => actions.includes(s));
}
