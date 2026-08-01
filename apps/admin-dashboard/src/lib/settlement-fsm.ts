// Settlement state machine — the single source of truth for the Upline↔Downline
// bank-settlement lifecycle: which action buttons appear for whom at each status, what
// each transition moves the status to, and what data is mandatory before it's allowed.
//
// Roles map from persona: PROVIDER = UPLINE (raises, confirms — never marks paid),
// MERCHANT = DOWNLINE (accepts, processes, pays), SUPER_ADMIN = ADMIN (override/reconcile).
// The API validates every transition against this table; the UIs render buttons from it,
// so the two can never drift.

export type SettleRole = "UPLINE" | "DOWNLINE" | "ADMIN";

export function settlementRole(persona: string): SettleRole | null {
  if (persona === "PROVIDER") return "UPLINE";
  if (persona === "MERCHANT") return "DOWNLINE";
  if (persona === "SUPER_ADMIN" || persona === "ADMIN") return "ADMIN";
  return null;
}

// Ordered happy-path for rendering the timeline as a progress rail.
export const BANK_HAPPY_PATH = [
  "REQUESTED", "ACCEPTED", "PROCESSING", "PAID", "VERIFIED", "RECONCILED",
] as const;

// Statuses from which no downline/upline action remains (terminal or admin-only).
export const TERMINAL_STATUSES = ["RECONCILED", "CANCELLED"] as const;

export type SettleMode = "BANK" | "USDT";

export interface TransitionDef {
  action: string;                 // canonical key, also the event.action
  label: string;                  // button text
  from: string[];                 // statuses this is offered from
  to: string;                     // resulting status; "*" = status unchanged (event-only action)
  roles: SettleRole[];            // who may perform it (ADMIN may always, see allowedActions)
  requires?: string[];            // mandatory detail fields (validated server-side)
  optional?: string[];            // optional detail fields (rendered in the dialog, not enforced)
  modes?: SettleMode[];           // restrict to a settlement mode (default: both)
  variant?: "primary" | "danger" | "warning" | "default";
  intent?: string;               // one-line hint shown in the confirm dialog
}

// Every non-terminal status — for actions available anywhere (lock, clarify…).
const ANY_OPEN = [
  "REQUESTED", "ACCEPTED", "PROCESSING", "PAID", "PARTIALLY_PAID", "UTR_SUBMITTED",
  "USDT_TRANSFERRED", "VERIFIED", "REJECTED", "ON_HOLD", "FAILED", "CORRECTION_REQUIRED",
  "ESCALATED", "COMPLIANCE_REVIEW", "INSUFFICIENT_BALANCE", "INVALID_BENEFICIARY", "REVIEW",
];

// The full bank-settlement transition table. USDT transitions are a later slice.
export const TRANSITIONS: TransitionDef[] = [
  // ── Downline processing path ──────────────────────────────────────────────
  { action: "ACCEPT", label: "Accept request", from: ["REQUESTED"], to: "ACCEPTED", roles: ["DOWNLINE"], variant: "primary" },
  { action: "REJECT", label: "Reject request", from: ["REQUESTED", "ACCEPTED"], to: "REJECTED", roles: ["DOWNLINE"], requires: ["reason"], variant: "danger" },
  { action: "HOLD", label: "Put on hold", from: ["REQUESTED", "ACCEPTED", "PROCESSING"], to: "ON_HOLD", roles: ["DOWNLINE"], requires: ["reason"], variant: "warning" },
  { action: "RESUME", label: "Resume", from: ["ON_HOLD"], to: "ACCEPTED", roles: ["DOWNLINE"], variant: "primary" },
  { action: "START", label: "Start processing", from: ["ACCEPTED"], to: "PROCESSING", roles: ["DOWNLINE"], variant: "primary" },
  { action: "MARK_PAID", label: "Mark as paid", from: ["PROCESSING"], to: "PAID", roles: ["DOWNLINE"],
    requires: ["paid_amount", "payment_mode", "payment_date", "utr", "source_bank"], modes: ["BANK"], variant: "primary" },
  // USDT: the downline (or Katana on an escalated request) moved the coins — mandatory
  // hash + quantity + rate evidence (BRD §5 "USDT Transferred").
  { action: "MARK_USDT_TRANSFERRED", label: "USDT transferred", from: ["PROCESSING"], to: "USDT_TRANSFERRED", roles: ["DOWNLINE"],
    requires: ["tx_hash", "usdt_quantity", "usdt_rate"], modes: ["USDT"], variant: "primary" },
  { action: "MARK_PARTIAL", label: "Mark partially paid", from: ["PROCESSING"], to: "PARTIALLY_PAID", roles: ["DOWNLINE"],
    requires: ["paid_amount", "utr", "reason", "expected_completion_date"], variant: "warning" },
  { action: "MARK_FAILED", label: "Mark as failed", from: ["PROCESSING"], to: "FAILED", roles: ["DOWNLINE"],
    requires: ["reason"], optional: ["error_code"], variant: "danger" },
  { action: "MARK_INSUFFICIENT", label: "Insufficient balance", from: ["REQUESTED", "ACCEPTED", "PROCESSING"], to: "INSUFFICIENT_BALANCE", roles: ["DOWNLINE"],
    requires: ["reason"], variant: "warning" },
  { action: "MARK_INVALID_BENEF", label: "Invalid beneficiary", from: ["REQUESTED", "ACCEPTED", "PROCESSING"], to: "INVALID_BENEFICIARY", roles: ["DOWNLINE"],
    requires: ["reason"], variant: "warning" },
  { action: "ESCALATE", label: "Escalate to Katana", from: ["REQUESTED", "ACCEPTED", "PROCESSING", "ON_HOLD", "INSUFFICIENT_BALANCE"], to: "ESCALATED", roles: ["DOWNLINE"],
    requires: ["reason"], variant: "warning" },
  { action: "RESUBMIT", label: "Resubmit", from: ["REJECTED", "CORRECTION_REQUIRED", "FAILED", "INSUFFICIENT_BALANCE", "INVALID_BENEFICIARY"], to: "PROCESSING", roles: ["DOWNLINE"], variant: "primary" },

  // ── Upline review path (never marks paid) ─────────────────────────────────
  { action: "CANCEL", label: "Cancel request", from: ["REQUESTED", "ACCEPTED", "INVALID_BENEFICIARY", "INSUFFICIENT_BALANCE"], to: "CANCELLED", roles: ["UPLINE"], requires: ["reason"], variant: "danger" },
  { action: "CONFIRM", label: "Confirm receipt", from: ["PAID", "PARTIALLY_PAID", "UTR_SUBMITTED", "USDT_TRANSFERRED"], to: "VERIFIED", roles: ["UPLINE"], variant: "primary" },
  { action: "DISPUTE", label: "Raise dispute", from: ["PAID", "PARTIALLY_PAID", "UTR_SUBMITTED", "USDT_TRANSFERRED"], to: "CORRECTION_REQUIRED", roles: ["UPLINE"],
    requires: ["reason"], variant: "danger" },
  // Dedicated §6 report buttons — same corrective destination as a dispute, but the
  // action key (and thus the timeline/webhook event) says exactly what went wrong.
  { action: "REPORT_PARTIAL", label: "Report partial receipt", from: ["PAID", "UTR_SUBMITTED"], to: "CORRECTION_REQUIRED", roles: ["UPLINE"],
    requires: ["reason"], modes: ["BANK"], variant: "warning" },
  { action: "REPORT_BAD_QTY", label: "Report incorrect quantity", from: ["USDT_TRANSFERRED"], to: "CORRECTION_REQUIRED", roles: ["UPLINE"],
    requires: ["reason"], modes: ["USDT"], variant: "warning" },
  { action: "REPORT_BAD_WALLET", label: "Report incorrect wallet", from: ["USDT_TRANSFERRED"], to: "CORRECTION_REQUIRED", roles: ["UPLINE"],
    requires: ["reason"], modes: ["USDT"], variant: "warning" },
  // Status-preserving question to the downline — logged on the timeline + notified,
  // the settlement stays exactly where it is.
  { action: "CLARIFY", label: "Request clarification", from: ANY_OPEN, to: "*", roles: ["UPLINE"], requires: ["reason"], variant: "default" },

  // ── Admin / Katana ────────────────────────────────────────────────────────
  // "Escalated to Katana → Accepted by Katana → Processing by Katana" (BRD §10): Katana
  // takes over an escalated request and processes it itself (USDT transfer or bank pay).
  { action: "PROCESS_ESCALATED", label: "Katana takes over", from: ["ESCALATED"], to: "PROCESSING", roles: ["ADMIN"], variant: "primary" },
  { action: "RECONCILE", label: "Mark reconciled", from: ["VERIFIED"], to: "RECONCILED", roles: ["ADMIN"], variant: "primary" },
  { action: "REVERSE", label: "Mark reversed", from: ["PAID", "VERIFIED", "PARTIALLY_PAID", "USDT_TRANSFERRED"], to: "REVERSED", roles: ["ADMIN"], requires: ["reason"], variant: "danger" },
  { action: "COMPLIANCE", label: "Send to compliance", from: ["REQUESTED", "ACCEPTED", "PROCESSING", "PAID"], to: "COMPLIANCE_REVIEW", roles: ["ADMIN"], requires: ["reason"], variant: "warning" },
  // §8 admin controls. LOCK freezes every non-admin action (transition route enforces);
  // REASSIGN moves the request to a different branch (only before any payment work).
  { action: "LOCK", label: "Lock settlement", from: ANY_OPEN, to: "*", roles: ["ADMIN"], requires: ["reason"], variant: "warning" },
  { action: "UNLOCK", label: "Unlock settlement", from: ANY_OPEN, to: "*", roles: ["ADMIN"], variant: "default" },
  { action: "REASSIGN", label: "Reassign downline", from: ["REQUESTED", "REJECTED", "ESCALATED", "INSUFFICIENT_BALANCE", "INVALID_BENEFICIARY"], to: "REQUESTED", roles: ["ADMIN"],
    requires: ["new_branch", "reason"], variant: "warning" },
];

// Actions available to `role` when the settlement is at `status` in `mode`. ADMIN sees
// every transition valid from the current status (full override), plus admin actions.
// A LOCKED settlement offers nothing except admin's UNLOCK (§8).
export function allowedActions(status: string, role: SettleRole, mode: SettleMode = "BANK", locked = false): TransitionDef[] {
  return TRANSITIONS.filter((t) => {
    if (locked) return t.action === "UNLOCK" && role === "ADMIN";
    if (t.action === "UNLOCK") return false;   // only meaningful while locked
    return t.from.includes(status)
      && (t.roles.includes(role) || role === "ADMIN")
      && (!t.modes || t.modes.includes(mode));
  });
}

export function findTransition(action: string): TransitionDef | undefined {
  return TRANSITIONS.find((t) => t.action === action);
}

// Validate a requested transition. Returns an error string, or null when allowed.
export function validateTransition(
  action: string, currentStatus: string, role: SettleRole, details: Record<string, unknown>,
  mode: SettleMode = "BANK", locked = false,
): string | null {
  const t = findTransition(action);
  if (!t) return `unknown action ${action}`;
  if (locked && !(action === "UNLOCK" && role === "ADMIN"))
    return "this settlement is locked by Katana — no actions until it is unlocked";
  if (action === "UNLOCK" && !locked) return "settlement is not locked";
  if (!t.from.includes(currentStatus)) return `${t.label} is not available from ${currentStatus}`;
  if (!(t.roles.includes(role) || role === "ADMIN")) return `your role cannot ${t.label}`;
  if (t.modes && !t.modes.includes(mode)) return `${t.label} does not apply to a ${mode} settlement`;
  for (const field of t.requires ?? []) {
    const v = details[field];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === ""))
      return `${field.replace(/_/g, " ")} is required to ${t.label}`;
  }
  return null;
}
