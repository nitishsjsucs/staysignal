// Local development sign-in (SPEC 17.1): GET /dev/login?principal=<id> signs a dev Access token for a local principal
// with the runtime-generated key. Honored only when SS_AUTH_MODE=dev and the host is localhost.
import { importJWK, SignJWT } from "jose";
import { type AppConfig, DEV_AUDIENCE, DEV_ISSUER } from "../config";

export async function mintDevToken(config: AppConfig, principalId: string, ttlSeconds = 8 * 3600, extra: Record<string, unknown> = {}): Promise<string> {
  if (!config.devSigningJwk) throw new Error("dev auth needs SS_DEV_SIGNING_JWK (npm run dev:keys)");
  const jwk = JSON.parse(config.devSigningJwk) as { kid?: string };
  const key = await importJWK(jwk, "RS256");
  const isService = principalId.startsWith("svc:");
  return new SignJWT({ email: isService ? undefined : principalId, ...(isService ? { common_name: principalId.slice(4) } : {}), ...extra })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid ?? "dev-1" })
    .setIssuer(DEV_ISSUER)
    .setAudience(DEV_AUDIENCE)
    .setSubject(isService ? "" : principalId)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}
