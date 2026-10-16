// The public demo's session (ADR 0018): a signed cookie `__Host-ss_demo` = "v1.<payload>.<mac>". The payload names one
// of the seven synthetic principals, the visitor's sandbox and the issue and expiry times (seconds); the MAC is
// HMAC-SHA256 under a key derived by HKDF from SS_DEMO_SIGNING_KEY, compared in constant time on every request.
// Roles and scopes come from policy/ on the server, never from the cookie, so editing the payload cannot raise a role.
// The __Host- prefix makes a browser refuse the cookie unless this host sets it, Secure, with Path=/ and no Domain, so
// another Worker on the account's workers.dev subdomain cannot plant a session (its own sandbox) for the demo; a
// request that carries two session cookies is refused. SameSite=Strict keeps it off navigations from other sites.
import { CAPS } from "../../shared/demo/budget";
import { LOCAL_PRINCIPALS, localPrincipal, type Principal } from "../../shared/policy/roles";
import { base32LowerNoPad, base64ToBytes, hkdfSha256 } from "./hmac";

export const DEMO_COOKIE = "__Host-ss_demo";
export const SANDBOX_ID = /^[a-z2-7]{20}$/;
export const DEFAULT_DEMO_PRINCIPAL = "pa-lead@larkspur.example";
/** The longest a session may live, in seconds: the sandbox lifetime. */
export const MAX_SESSION_SECONDS = CAPS.sandboxLifetimeMs / 1000;
/** Clock skew tolerated on the issue time, in seconds. */
const SKEW = 60;

export interface DemoSession {
  principal: string;
  sandbox: string;
  iat: number;
  exp: number;
}

export type DemoVerdict = { ok: true; session: DemoSession } | { ok: false; reason: "missing" | "invalid" | "expired" };

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const t = text.replace(/-/g, "+").replace(/_/g, "/");
    return base64ToBytes(t.padEnd(Math.ceil(t.length / 4) * 4, "="));
  } catch {
    return null;
  }
}

const keys = new Map<string, Promise<CryptoKey>>();

/** The session MAC key: HKDF over the signing key with its own salt and info, so it never equals another derived key. */
function macKey(signingKeyB64: string): Promise<CryptoKey> {
  let k = keys.get(signingKeyB64);
  if (!k) {
    k = (async () => {
      const raw = await hkdfSha256(base64ToBytes(signingKeyB64), enc.encode("staysignal/demo-session"), enc.encode("ss-demo-session:v1"), 32);
      return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    })();
    keys.set(signingKeyB64, k);
  }
  return k;
}

async function mac(signingKeyB64: string, text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await macKey(signingKeyB64), enc.encode(text)));
}

/** Constant-time comparison: workerd's crypto.subtle.timingSafeEqual, or an XOR fold of equal-length inputs. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** A new sandbox ID: 20 base32 characters, 100 random bits. */
export function newSandboxId(): string {
  return base32LowerNoPad(crypto.getRandomValues(new Uint8Array(13))).slice(0, 20);
}

export function isDemoPrincipal(id: string): boolean {
  return LOCAL_PRINCIPALS.some((p) => p.id === id);
}

export async function issueSession(signingKeyB64: string, s: DemoSession): Promise<string> {
  if (!isDemoPrincipal(s.principal) || !SANDBOX_ID.test(s.sandbox)) throw new Error("not a demo principal or sandbox");
  if (!(s.exp > s.iat) || s.exp - s.iat > MAX_SESSION_SECONDS) throw new Error("a demo session lives at most the sandbox lifetime");
  return signPayload(signingKeyB64, { p: s.principal, s: s.sandbox, iat: s.iat, exp: s.exp });
}

/** Signs any payload object as a v1 cookie value. Only issueSession uses it in the Worker; tests use it to forge
 * cookies that a valid key signs but the rules refuse. */
export async function signPayload(signingKeyB64: string, body: Record<string, unknown>): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(body)));
  return `v1.${payload}.${b64url(await mac(signingKeyB64, `v1.${payload}`))}`;
}

export async function verifySession(signingKeyB64: string, value: string | null, nowSeconds: number): Promise<DemoVerdict> {
  if (!value) return { ok: false, reason: "missing" };
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || value.length > 1024) return { ok: false, reason: "invalid" };
  const [, payload, sig] = parts as [string, string, string];
  const given = fromB64url(sig);
  if (!given || given.length !== 32) return { ok: false, reason: "invalid" };
  if (!timingSafeEqual(await mac(signingKeyB64, `v1.${payload}`), given)) return { ok: false, reason: "invalid" };
  let body: { p?: unknown; s?: unknown; iat?: unknown; exp?: unknown };
  try {
    body = JSON.parse(dec.decode(fromB64url(payload) ?? new Uint8Array())) as typeof body;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const { p, s, iat, exp } = body;
  if (typeof p !== "string" || !isDemoPrincipal(p) || typeof s !== "string" || !SANDBOX_ID.test(s)) return { ok: false, reason: "invalid" };
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) return { ok: false, reason: "invalid" };
  const i = iat as number;
  const x = exp as number;
  if (x <= i || x - i > MAX_SESSION_SECONDS || i > nowSeconds + SKEW) return { ok: false, reason: "invalid" };
  if (x <= nowSeconds) return { ok: false, reason: "expired" };
  return { ok: true, session: { principal: p, sandbox: s, iat: i, exp: x } };
}

/** The principal of a verified session: scopes from policy/, plus the sandbox it acts in. */
export function sessionPrincipal(s: DemoSession): Principal {
  const p = localPrincipal(s.principal);
  if (!p) throw new Error("not a demo principal");
  return { ...p, sandbox: { id: s.sandbox, exp: s.exp } };
}

export function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `${DEMO_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export function clearSessionCookie(): string {
  return `${DEMO_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** What readCookie returns for a cookie the request carries more than once, or that does not decode: no session has
 * this value, so it verifies as invalid. A browser keeps one __Host- cookie per name, so two mean someone else set one. */
export const INVALID_COOKIE = "invalid";

/** The value of the named cookie; null when absent; INVALID_COOKIE when carried more than once or not decodable. */
export function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("Cookie") ?? "";
  let found: string | null = null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== name) continue;
    if (found !== null) return INVALID_COOKIE;
    try {
      found = decodeURIComponent(v.join("="));
    } catch {
      return INVALID_COOKIE;
    }
  }
  return found;
}

const clientKeys = new Map<string, Promise<CryptoKey>>();

/** The gate's key for a client: 16 hex characters of an HMAC of its address under a key derived from the signing key
 * (its own HKDF info), so no address is ever stored. */
export async function clientKey(signingKeyB64: string, address: string): Promise<string> {
  let k = clientKeys.get(signingKeyB64);
  if (!k) {
    k = (async () => {
      const raw = await hkdfSha256(base64ToBytes(signingKeyB64), enc.encode("staysignal/demo-client"), enc.encode("ss-demo-client:v1"), 32);
      return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    })();
    clientKeys.set(signingKeyB64, k);
  }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await k, enc.encode(address)));
  return Array.from(mac.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The part of a client address the gate counts: an IPv6 address by its /64 prefix (one subscriber's network, which
 * one client can fill with addresses), an IPv4 address (or an IPv4-mapped IPv6 one) whole. Anything unparseable is
 * counted as given. */
export function clientPrefix(address: string): string {
  const a = address.trim().toLowerCase().replace(/%.*$/, "");
  if (!a.includes(":")) return a;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1]!;
  const halves = a.split("::");
  if (halves.length > 2) return a;
  const part = (s: string | undefined): string[] => (s ? s.split(":") : []);
  let head = part(halves[0]);
  let tail = part(halves[1]);
  // an embedded IPv4 tail ("::1.2.3.4") is two groups
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec((halves.length === 2 ? tail : head).at(-1) ?? "");
  if (v4) {
    const [b0, b1, b2, b3] = v4.slice(1).map(Number) as [number, number, number, number];
    const groups = [((b0 << 8) | b1).toString(16), ((b2 << 8) | b3).toString(16)];
    if (halves.length === 2) tail = [...tail.slice(0, -1), ...groups];
    else head = [...head.slice(0, -1), ...groups];
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return a;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return a;
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

const keyIds = new Map<string, Promise<string>>();

/** A fingerprint of the signing key (HKDF with its own info, 16 hex characters). The gate counts live and daily
 * sandboxes for the current key only, so rotating the key frees the gate at once instead of after 4 hours. */
export function demoKeyId(signingKeyB64: string): Promise<string> {
  let k = keyIds.get(signingKeyB64);
  if (!k) {
    k = (async () => {
      const raw = await hkdfSha256(base64ToBytes(signingKeyB64), enc.encode("staysignal/demo-key-id"), enc.encode("ss-demo-kid:v1"), 8);
      return Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
    })();
    keyIds.set(signingKeyB64, k);
  }
  return k;
}
