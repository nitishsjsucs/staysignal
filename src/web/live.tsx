// Live WorkspaceAgent state over WebSocket (SPEC 14.5): the published run, routine runs, pending approvals, open
// incidents and the audit head, broadcast by the server. Any change invalidates cached API reads so pages refetch.
import { useAgent } from "agents/react";
import { createContext, type ReactNode, useContext, useState } from "react";
import { invalidate } from "./api";

export interface WorkspaceLive {
  published: { runId: string; cutoff: string; version: number } | null;
  recentRuns: { runId: string; status: string; cutoff: string; version: number; mapping: string }[];
  routineRuns: { routineId: string; status: string; step: string; updatedAt: string }[];
  pendingApprovals: { subjectId: string; kind: string; proposer: string; title: string }[];
  openIncidents: { incidentId: string; runId: string; checks: string[] }[];
  auditHead: { seq: number; hash: string; anchoredAt: string | null };
  mapping: { payroll: string };
  demoEpoch: number;
  epochStartMs: number;
}

const Ctx = createContext<WorkspaceLive | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WorkspaceLive | null>(null);
  useAgent<WorkspaceLive>({
    agent: "workspace-agent",
    basePath: "agents-ws/workspace",
    onStateUpdate: (s) => {
      setState(s);
      invalidate();
    },
  });
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceLive | null {
  return useContext(Ctx);
}
