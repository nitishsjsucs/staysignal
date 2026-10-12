// Approval rules (SPEC 14.8, ADR 0006): the approver is a human other than the proposer of record who holds the
// subject's scope, and the subject has not changed since it was proposed. Checked in the callable and again in the
// workflow step after the gate wakes.
import { hasScope, type Principal } from "../../shared/policy/roles";

export type ApprovalRefusalCode = "SELF_APPROVAL" | "WRONG_ROLE" | "AGENT_PRINCIPAL" | "STALE_SUBJECT" | "NOT_PENDING";

export interface PendingApproval {
  subject_id: string;
  subject_kind: "review" | "mapping" | "publish";
  proposer: string;
  proposer_kind: string;
  required_scope: string;
  status: string;
  subject_hash: string;
  workflow_instance_id: string | null;
}

export const APPROVAL_MESSAGES: Record<ApprovalRefusalCode, string> = {
  SELF_APPROVAL: "Refused: nobody approves their own proposal. A different person with approval rights must approve it.",
  WRONG_ROLE: "Refused: your role does not hold the scope this approval needs.",
  AGENT_PRINCIPAL: "Refused: agents draft and propose; they never approve.",
  STALE_SUBJECT: "Refused: the subject changed after it was proposed; review the new version.",
  NOT_PENDING: "This subject is not waiting for an approval.",
};

export function approvalRefusal(p: Principal, a: PendingApproval, currentSubjectHash: string): ApprovalRefusalCode | null {
  if (a.status !== "pending") return "NOT_PENDING";
  if (p.kind !== "human") return "AGENT_PRINCIPAL";
  if (a.proposer === p.id) return "SELF_APPROVAL";
  if (!hasScope(p, a.required_scope)) return "WRONG_ROLE";
  if (a.subject_hash !== currentSubjectHash) return "STALE_SUBJECT";
  return null;
}
