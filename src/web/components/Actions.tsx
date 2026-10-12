// Action controls with server-side rules: approve or reject with an optional reason, and rollback with a required
// reason. Refusals (SELF_APPROVAL, WRONG_ROLE, AGENT_PRINCIPAL, STALE_SUBJECT) come back from the WorkspaceAgent and
// are shown with their rule.
import { useState } from "react";
import { invalidate, postJSON } from "../api";
import { IconUndo } from "./icons";
import { StatusPill } from "./ui";

interface Outcome {
  ok: boolean;
  code?: string;
  message?: string;
}

export function ApproveReject({ subjectId, testid }: { subjectId: string; testid?: string }) {
  const [reason, setReason] = useState("");
  const [out, setOut] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (kind: "approve" | "reject") => {
    setBusy(true);
    try {
      const r = await postJSON<Outcome>(`/api/approvals/${encodeURIComponent(subjectId)}/${kind}`, { reason: reason || null });
      setOut(r);
      invalidate();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid={testid}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input className="select" style={{ flex: 1, minWidth: 140 }} placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Approval reason" />
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act("approve")}>
          Approve
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act("reject")}>
          Reject
        </button>
      </div>
      {out ? out.ok ? <StatusPill status="good">Done</StatusPill> : (
        <div role="alert" data-testid="approval-refusal">
          <StatusPill status="critical">{out.code}</StatusPill> <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{out.message}</span>
        </div>
      ) : null}
    </div>
  );
}

export function RollbackControl({ seq, label = "Roll back", defaultReason = "" }: { seq: number; label?: string; defaultReason?: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(defaultReason);
  const [out, setOut] = useState<Outcome | null>(null);
  if (!open)
    return (
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        <IconUndo size={14} /> {label}
      </button>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input className="select" style={{ flex: 1, minWidth: 180 }} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Rollback reason" />
        <button
          type="button"
          className="btn btn-sm btn-danger"
          disabled={!reason.trim()}
          onClick={async () => {
            const r = await postJSON<Outcome>(`/api/actions/${seq}/rollback`, { reason });
            setOut(r);
            invalidate();
          }}
        >
          Confirm rollback
        </button>
      </div>
      {out ? out.ok ? <StatusPill status="good">Rolled back; a reversal entry was added</StatusPill> : <StatusPill status="critical">{out.code}: {out.message}</StatusPill> : null}
    </div>
  );
}
