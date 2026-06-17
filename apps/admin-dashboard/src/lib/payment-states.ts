// Payment state machine (BRD §7 — module P3).
//
//   CREATED → AUTH_REQUIRED → AUTH_CHALLENGE → AUTHENTICATED → PROCESSING → SUCCESS
//   CREATED → PROCESSING → PENDING → SUCCESS / FAILED / EXPIRED
//   SUCCESS → REFUND_REQUESTED → REFUNDED / PARTIALLY_REFUNDED
//   SUCCESS → DISPUTE_OPEN → REPRESENTMENT → ACCEPTED / WON / LOST
//
// Enforced in the app — DB column has no CHECK so legacy INITIATED rows
// continue to render. `applyTransition` returns ok/blocked + reason.

export type PaymentState =
  // BRD states
  | "CREATED"
  | "AUTH_REQUIRED"
  | "AUTH_CHALLENGE"
  | "AUTHENTICATED"
  | "PROCESSING"
  | "PENDING"
  | "SUCCESS"
  | "FAILED"
  | "EXPIRED"
  | "REFUND_REQUESTED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED"
  | "DISPUTE_OPEN"
  | "REPRESENTMENT"
  | "ACCEPTED"
  | "WON"
  | "LOST"
  // Legacy compatibility with rows seeded before Sprint 2.
  | "INITIATED";

const TERMINAL: ReadonlySet<PaymentState> = new Set([
  "FAILED", "EXPIRED", "REFUNDED", "WON", "LOST",
]);

// Directed graph of allowed transitions.
const TRANSITIONS: Record<PaymentState, PaymentState[]> = {
  INITIATED:           ["CREATED", "AUTH_REQUIRED", "PROCESSING", "FAILED", "EXPIRED"],
  CREATED:             ["AUTH_REQUIRED", "PROCESSING", "FAILED", "EXPIRED"],
  AUTH_REQUIRED:       ["AUTH_CHALLENGE", "AUTHENTICATED", "FAILED", "EXPIRED"],
  AUTH_CHALLENGE:      ["AUTHENTICATED", "FAILED", "EXPIRED"],
  AUTHENTICATED:       ["PROCESSING", "FAILED"],
  PROCESSING:          ["PENDING", "SUCCESS", "FAILED", "EXPIRED"],
  PENDING:             ["SUCCESS", "FAILED", "EXPIRED"],
  SUCCESS:             ["REFUND_REQUESTED", "DISPUTE_OPEN"],
  FAILED:              [],
  EXPIRED:             [],
  REFUND_REQUESTED:    ["REFUNDED", "PARTIALLY_REFUNDED"],
  REFUNDED:            [],
  PARTIALLY_REFUNDED:  ["REFUND_REQUESTED", "DISPUTE_OPEN"],
  DISPUTE_OPEN:        ["REPRESENTMENT", "ACCEPTED", "WON", "LOST"],
  REPRESENTMENT:       ["ACCEPTED", "WON", "LOST"],
  ACCEPTED:            ["WON", "LOST"],
  WON:                 [],
  LOST:                [],
};

export function isTerminal(s: PaymentState): boolean { return TERMINAL.has(s); }

export function canTransition(from: PaymentState, to: PaymentState): boolean {
  if (from === to) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export interface TransitionResult { ok: boolean; reason?: string }

export function applyTransition(from: PaymentState, to: PaymentState): TransitionResult {
  if (!canTransition(from, to))
    return { ok: false, reason: `${from} cannot transition to ${to}` };
  if (isTerminal(from) && from !== to)
    return { ok: false, reason: `${from} is terminal` };
  return { ok: true };
}

// For the UI stepper — the canonical happy-path ordering.
export const STATE_ORDER: PaymentState[] = [
  "CREATED",
  "AUTH_REQUIRED",
  "AUTH_CHALLENGE",
  "AUTHENTICATED",
  "PROCESSING",
  "PENDING",
  "SUCCESS",
];

export function stateColor(s: PaymentState): "brand" | "success" | "warning" | "danger" | "default" {
  if (s === "SUCCESS" || s === "WON" || s === "REFUNDED") return "success";
  if (s === "FAILED" || s === "EXPIRED" || s === "LOST") return "danger";
  if (s === "AUTH_CHALLENGE" || s === "PENDING" || s === "DISPUTE_OPEN") return "warning";
  if (s === "INITIATED") return "default";
  return "brand";
}
