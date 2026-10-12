// npm run hooks:install: points .git/hooks/pre-commit at the committed scripts/hooks/pre-commit (SPEC 22.6).
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_BODY = '#!/bin/sh\n# Installed by npm run hooks:install (StaySignal). Do not edit; edit scripts/hooks/pre-commit.\nexec "$(git rev-parse --show-toplevel)/scripts/hooks/pre-commit" "$@"\n';

export function installHooks(root: string): string {
  const gitDir = join(root, ".git");
  if (!existsSync(gitDir)) throw new Error("not a git repository root");
  mkdirSync(join(gitDir, "hooks"), { recursive: true });
  const target = join(gitDir, "hooks", "pre-commit");
  writeFileSync(target, HOOK_BODY);
  chmodSync(target, 0o755);
  chmodSync(join(root, "scripts", "hooks", "pre-commit"), 0o755);
  return target;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = installHooks(process.cwd());
  console.log(`hooks:install: wrote ${target}`);
  if (!process.env.SS_PRIVATE_DENYLIST) {
    console.log("hooks:install: SS_PRIVATE_DENYLIST is not set; every commit will be refused until it names the private deny-list");
  }
}
