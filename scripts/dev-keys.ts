// npm run dev:keys: local development secrets in .dev.vars (gitignored): an RS256 key pair for the dev Access
// stand-in (/dev/login signs, the shared verifier checks), the HMAC master key and the runner token. Pattern copied
// from onboardflow scripts/dev-keys.ts (MIT). Only public JWKS are ever committed; private keys are generated here.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair } from "jose";

export const DEV_KID = "dev-1";

export interface DevSecrets {
  SS_DEV_JWKS: string;
  SS_DEV_SIGNING_JWK: string;
  SS_HMAC_MASTER_KEY: string;
  SS_RUNNER_TOKEN: string;
}

export async function generateDevSecrets(): Promise<DevSecrets> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const pub = { ...(await exportJWK(publicKey)), kid: DEV_KID, alg: "RS256", use: "sig" };
  const priv = { ...(await exportJWK(privateKey)), kid: DEV_KID, alg: "RS256" };
  return {
    SS_DEV_JWKS: JSON.stringify({ keys: [pub] }),
    SS_DEV_SIGNING_JWK: JSON.stringify(priv),
    SS_HMAC_MASTER_KEY: Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i)).toString("base64"),
    SS_RUNNER_TOKEN: randomBytes(24).toString("hex"),
  };
}

export function toDevVars(secrets: DevSecrets): string {
  return `${Object.entries(secrets)
    .map(([k, v]) => `${k}='${v}'`)
    .join("\n")}\n`;
}

export function readDevVars(path = ".dev.vars"): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)='(.*)'$/.exec(line.trim());
    if (m && m[1] && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
}

async function main(): Promise<void> {
  const out = process.argv[2] ?? ".dev.vars";
  if (existsSync(out) && !process.argv.includes("--force")) {
    console.log(`dev:keys: ${out} exists (use --force to replace)`);
    return;
  }
  writeFileSync(out, toDevVars(await generateDevSecrets()), { mode: 0o600 });
  console.log(`dev:keys: wrote ${out} (SS_DEV_JWKS, SS_DEV_SIGNING_JWK, SS_HMAC_MASTER_KEY, SS_RUNNER_TOKEN)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
