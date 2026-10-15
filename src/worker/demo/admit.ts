// The plain-Response form of a refused admission, for paths outside Hono (agent WebSocket upgrades).
import { BUSY_MESSAGE_TEXT } from "./messages";
import type { AdmitVerdict } from "./meter";

export function admitJson(v: Exclude<AdmitVerdict, { ok: true }>): Response {
  if (v.code === "SANDBOX_EXPIRED") return Response.json({ error: "unauthenticated", reason: "sandbox_expired" }, { status: 401 });
  return Response.json({ error: "busy", code: v.code, message: BUSY_MESSAGE_TEXT, retry_after_seconds: v.retryAfterSeconds }, { status: 429, headers: { "Retry-After": String(v.retryAfterSeconds) } });
}
