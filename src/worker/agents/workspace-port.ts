// The WorkspaceAgent as seen by tools and the API: results, drafts and the published pointer over Durable Object RPC.
// The instance is the shared "larkspur" workspace, or the visitor's sandbox "sbx-<id>" in the public demo (ADR 0018).
import { getAgentByName } from "agents";
import type { Principal } from "../../shared/policy/roles";
import type { ReviewDraft, ToolResult, WorkspacePort } from "../../shared/tools/registry";
import { workspaceName } from "../auth/principal";

export const WORKSPACE_NAME = "larkspur";

export function workspace(env: Env, p?: Pick<Principal, "sandbox"> | null) {
  return getAgentByName(env.WORKSPACE_AGENT, workspaceName(p));
}

export type WorkspaceHandle = Awaited<ReturnType<typeof workspace>>;
export type WorkspaceRef = () => Promise<WorkspaceHandle>;

/** One stub for a whole request or turn: getAgentByName makes an initialization RPC on every call, and each RPC is a
 * Durable Object request against the Workers Free allowance. */
export function workspaceRef(env: Env, p?: Pick<Principal, "sandbox"> | null): WorkspaceRef {
  let stub: Promise<WorkspaceHandle> | null = null;
  return () => {
    stub ??= workspace(env, p).catch((e: unknown) => {
      stub = null;
      throw e;
    });
    return stub;
  };
}

export function workspaceStub(env: Env, p?: Pick<Principal, "sandbox"> | null, ref: WorkspaceRef = workspaceRef(env, p)): WorkspacePort & { storeTrace(id: string, owner: string, payload: unknown): Promise<void> } {
  return {
    async storeResult(result: ToolResult<unknown>, owner: string) {
      await (await ref()).storeResult(result, owner);
    },
    async saveDraft(draft: ReviewDraft, owner: string) {
      await (await ref()).saveDraft(draft, owner);
    },
    async publishedRunId() {
      return (await ref()).publishedRunId();
    },
    async routineCheckResults() {
      return (await ref()).routineCheckResults();
    },
    async storeTrace(id: string, owner: string, payload: unknown) {
      await (await ref()).storeTrace(id, owner, payload);
    },
  };
}
