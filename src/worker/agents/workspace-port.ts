// The WorkspaceAgent as seen by tools and the API: results, drafts and the published pointer over Durable Object RPC.
import { getAgentByName } from "agents";
import type { ReviewDraft, ToolResult, WorkspacePort } from "../../shared/tools/registry";

export const WORKSPACE_NAME = "larkspur";

export function workspace(env: Env) {
  return getAgentByName(env.WORKSPACE_AGENT, WORKSPACE_NAME);
}

export function workspaceStub(env: Env): WorkspacePort & { storeTrace(id: string, owner: string, payload: unknown): Promise<void> } {
  return {
    async storeResult(result: ToolResult<unknown>, owner: string) {
      await (await workspace(env)).storeResult(result, owner);
    },
    async saveDraft(draft: ReviewDraft, owner: string) {
      await (await workspace(env)).saveDraft(draft, owner);
    },
    async publishedRunId() {
      return (await workspace(env)).publishedRunId();
    },
    async routineCheckResults() {
      return (await workspace(env)).routineCheckResults();
    },
    async storeTrace(id: string, owner: string, payload: unknown) {
      await (await workspace(env)).storeTrace(id, owner, payload);
    },
  };
}
