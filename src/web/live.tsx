// Live WorkspaceAgent state over WebSocket (SPEC 14.5): the published run, routine runs, pending approvals, open
// incidents and the audit head, broadcast by the server. Any change invalidates cached API reads so pages refetch.
import { useAgent } from "agents/react";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
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

/** `coalesceMs` (the public demo): a burst of state updates, such as a routine's steps, refetches the page once at
 * its end rather than once per update, which keeps a sandbox inside its request units (ADR 0018). */
export function WorkspaceProvider({ children, coalesceMs = 0 }: { children: ReactNode; coalesceMs?: number }) {
  const [state, setState] = useState<WorkspaceLive | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  useAgent<WorkspaceLive>({
    agent: "workspace-agent",
    basePath: "agents-ws/workspace",
    onStateUpdate: (s) => {
      setState(s);
      if (!coalesceMs) return invalidate();
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        invalidate();
      }, coalesceMs);
    },
  });
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceLive | null {
  return useContext(Ctx);
}
