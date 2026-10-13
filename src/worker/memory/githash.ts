// Git-style hashes for the production memory (SPEC 14.10): "git-style history, not git". A file's blob hash is what
// `git hash-object` computes (SHA-1 of "blob <bytes>\0<content>"); the tree and commit hashes are simplified: the
// tree hashes the sorted "<path> <blob>" lines, and the commit hashes its tree, parent, author, date and message.
// Short IDs are the first 16 hex characters, as the engine serves them.
const enc = new TextEncoder();

async function sha1(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function blobHash(text: string): Promise<string> {
  const body = enc.encode(text);
  const head = enc.encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head, 0);
  all.set(body, head.length);
  return sha1(all);
}

export async function treeHash(entries: Record<string, string>): Promise<string> {
  return sha1(enc.encode(Object.keys(entries).sort().map((p) => `${p} ${entries[p]}`).join("\n")));
}

export const AGENT_AUTHOR = "StaySignal Agent <agent@larkspur.example>";

export async function commitHash(tree: string, parent: string | null, date: string, message: string): Promise<string> {
  return sha1(enc.encode(`tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author ${AGENT_AUTHOR} ${date}\ncommitter ${AGENT_AUTHOR} ${date}\n\n${message}\n`));
}

export const short = (sha: string) => sha.slice(0, 16);
