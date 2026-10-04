// Banker-side chargebacks: which rule applies, what it debits, and what state the chargeback is in.
//
// PURE (no `pg`): lib/chargebacks-store does the reading and writing, and the tests hold this.
//
// A chargeback reported by a bank, acquirer or gateway is a financial event against the ORIGINAL
// pay-in. It is matched to that pay-in inside the pay-in's channel (an INTENT pay-in never answers
// for a P2P bank record, or the other way round), evaluated against the merchant's configured rule,
// and only then debited. Nothing is debited on a guess:
//
//   - no pay-in, or several that fit         → CB_PENDING_MATCH / CB_MANUAL_REVIEW
//   - the pay-in was not paid, the amount is more than it, or it is already charged back
//                                            → CB_MANUAL_REVIEW
//   - no rule configured                     → CB_RULE_EXCEPTION (the ratio is never invented)
//   - the rule asks for review, or the debit is above its automatic limit → CB_MANUAL_REVIEW
//   - a 0% rule                              → CB_MATCHED, nothing to debit
//   - otherwise the rule's debit is posted   → CB_DEBIT_POSTED (all of it) / CB_PARTIAL_DEBIT
//
// A reversal (representment won, recovery, the bank cancelling) is a new CHARGEBACK_REVERSAL
// entry linked to the debit; the debit itself is never changed or removed (CB_REVERSED once all
// of it is reversed).

export const CB_STATES = [
  "CB_PENDING_MATCH", "CB_MATCHED", "CB_MANUAL_REVIEW", "CB_RULE_EXCEPTION",
  "CB_DEBIT_POSTED", "CB_PARTIAL_DEBIT", "CB_REVERSED", "CB_DISMISSED",
] as const;
export type CbState = (typeof CB_STATES)[number];

/** Still needs something done: a match, a rule or a person. */
export const CB_OPEN: CbState[] = ["CB_PENDING_MATCH", "CB_MANUAL_REVIEW", "CB_RULE_EXCEPTION"];

export const CB_LABEL: Record<CbState, string> = {
  CB_PENDING_MATCH: "Finding the payment",
  CB_MATCHED: "Matched, nothing to debit",
  CB_MANUAL_REVIEW: "Being reviewed",
  CB_RULE_EXCEPTION: "No rule set",
  CB_DEBIT_POSTED: "Debited",
  CB_PARTIAL_DEBIT: "Partly debited",
  CB_REVERSED: "Reversed",
  CB_DISMISSED: "Dismissed",
};

export function cbVariant(s: CbState): "success" | "warning" | "danger" | "info" | "default" {
  if (s === "CB_REVERSED" || s === "CB_MATCHED") return "success";
  if (s === "CB_DEBIT_POSTED" || s === "CB_PARTIAL_DEBIT") return "danger";
  if (s === "CB_DISMISSED") return "default";
  if (s === "CB_PENDING_MATCH") return "info";
  return "warning";
}

/** Staff who record chargebacks, decide them and set the rules. */
export const CB_STAFF = ["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK", "COMPLIANCE"] as const;

export const CB_SOURCES = ["BANK", "ACQUIRER", "GATEWAY", "SETTLEMENT_FILE", "OTHER"] as const;
export type CbSource = (typeof CB_SOURCES)[number];

export const REVERSAL_KINDS = ["REPRESENTMENT_WON", "RECOVERED", "CANCELLED_BY_BANK", "POSTED_IN_ERROR"] as const;
export type ReversalKind = (typeof REVERSAL_KINDS)[number];

export interface CbRule {
  id: string;
  provider_id: string | null;
  banker_code: string | null;
  channel_type: "INTENT" | "P2P" | null;
  reason_code: string | null;
  debit_bps: number;
  auto_debit: boolean;
  auto_max_amount: number | null;
  version: number;
  effective_from: string;
  effective_to: string | null;
}

export interface RuleScope { providerId: string | null; banker: string | null; channel: string | null; reasonCode: string | null; at: Date }

/**
 * The most specific rule in force at `at` that fits: one banker beats the whole merchant, which
 * beats every merchant; then one channel beats both, then one reason code beats every reason. The
 * newest wins a tie. null when none fits.
 */
export function pickCbRule(rules: CbRule[], s: RuleScope): CbRule | null {
  const t = s.at.getTime();
  const fits = rules.filter((r) =>
    Date.parse(r.effective_from) <= t && (r.effective_to == null || Date.parse(r.effective_to) > t)
    && (r.provider_id == null || r.provider_id === s.providerId)
    && (r.banker_code == null || r.banker_code === s.banker)
    && (r.channel_type == null || r.channel_type === s.channel)
    && (r.reason_code == null || (s.reasonCode != null && r.reason_code.toUpperCase() === s.reasonCode.toUpperCase())));
  const score = (r: CbRule) => (r.banker_code ? 8 : 0) + (r.provider_id ? 4 : 0) + (r.channel_type ? 2 : 0) + (r.reason_code ? 1 : 0);
  fits.sort((a, b) => score(b) - score(a) || Date.parse(b.effective_from) - Date.parse(a.effective_from));
  return fits[0] ?? null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The debit a rule makes on a chargeback amount, in rupees. */
export function ruleDebit(amount: number, rule: Pick<CbRule, "debit_bps">): number {
  return r2((amount * rule.debit_bps) / 10_000);
}

export interface MatchedPayin {
  id: string;
  status: string;
  amount: number;
  channel_type: string;
  merchant_id: string | null;
}

export interface CbDecisionInput {
  amount: number;
  /** null when no pay-in was found; `candidates` says how many fitted. */
  order: MatchedPayin | null;
  candidates: number;
  /** What other chargebacks have already claimed of this pay-in (their amounts, open or debited). */
  alreadyClaimed: number;
  rule: CbRule | null;
}

export type CbDecision =
  | { state: "CB_PENDING_MATCH" | "CB_MANUAL_REVIEW" | "CB_RULE_EXCEPTION"; note: string; debit: null }
  | { state: "CB_MATCHED"; note: string; debit: 0 }
  | { state: "CB_DEBIT_POSTED" | "CB_PARTIAL_DEBIT"; note: string; debit: number };

const PAID = new Set(["SUCCESS", "SUCCEEDED"]);

export function decideChargeback(i: CbDecisionInput): CbDecision {
  if (!i.order) {
    return i.candidates > 1
      ? { state: "CB_MANUAL_REVIEW", debit: null, note: `${i.candidates} pay-ins fit this record; a person must choose the original.` }
      : { state: "CB_PENDING_MATCH", debit: null, note: "No pay-in matches the reference given." };
  }
  if (!PAID.has(i.order.status)) {
    return { state: "CB_MANUAL_REVIEW", debit: null, note: `The original pay-in is ${i.order.status.toLowerCase()}, not paid.` };
  }
  if (i.amount > i.order.amount + 0.005) {
    return { state: "CB_MANUAL_REVIEW", debit: null, note: `The chargeback (₹${i.amount.toFixed(2)}) is more than the pay-in (₹${i.order.amount.toFixed(2)}).` };
  }
  if (i.alreadyClaimed + i.amount > i.order.amount + 0.005) {
    return { state: "CB_MANUAL_REVIEW", debit: null, note: `Other chargebacks already claim ₹${i.alreadyClaimed.toFixed(2)} of this pay-in; together they exceed it.` };
  }
  if (!i.rule) {
    return { state: "CB_RULE_EXCEPTION", debit: null, note: "No chargeback rule is set for this merchant and channel, so nothing is debited." };
  }
  const debit = ruleDebit(i.amount, i.rule);
  const ratio = `${(i.rule.debit_bps / 100).toFixed(2).replace(/\.00$/, "")}%`;
  if (!i.rule.auto_debit) {
    return { state: "CB_MANUAL_REVIEW", debit: null, note: `The rule (${ratio}) asks for a person to approve every debit.` };
  }
  if (i.rule.auto_max_amount != null && debit > i.rule.auto_max_amount + 0.005) {
    return { state: "CB_MANUAL_REVIEW", debit: null, note: `The debit (₹${debit.toFixed(2)}) is above the rule's automatic limit (₹${i.rule.auto_max_amount.toFixed(2)}).` };
  }
  if (debit <= 0) return { state: "CB_MATCHED", debit: 0, note: `The rule debits ${ratio}: nothing to debit.` };
  return {
    state: debit >= i.amount - 0.005 ? "CB_DEBIT_POSTED" : "CB_PARTIAL_DEBIT",
    debit,
    note: `Debited ₹${debit.toFixed(2)} of ₹${i.amount.toFixed(2)} (${ratio}, rule v${i.rule.version}).`,
  };
}

/** The state after postings: what was debited and reversed decides it. */
export function stateAfterPostings(amount: number, debited: number, reversed: number): CbState {
  if (debited > 0 && reversed >= debited - 0.005) return "CB_REVERSED";
  return debited >= amount - 0.005 ? "CB_DEBIT_POSTED" : "CB_PARTIAL_DEBIT";
}

/**
 * The chain is whole when the banker event, the original pay-in, the rule and the postings agree:
 * the record is matched to a pay-in of the same channel, and what was posted is what the rule
 * calculated (or a person's stated amount, recorded as such). Only then is a chargeback reconciled.
 */
export function chainProblems(c: {
  state: CbState; order_id: string | null; channel_type: string | null; order_channel: string | null;
  calculated_debit: number | null; debited: number; override: boolean;
}): string[] {
  const out: string[] = [];
  if (c.state === "CB_DISMISSED") return out;
  if (!c.order_id) { out.push("not matched to a pay-in"); return out; }
  if (c.order_channel && c.channel_type !== c.order_channel) out.push(`recorded on ${c.channel_type}, the pay-in is ${c.order_channel}`);
  if (CB_OPEN.includes(c.state)) out.push("waiting for a rule or a person");
  if ((c.state === "CB_DEBIT_POSTED" || c.state === "CB_PARTIAL_DEBIT" || c.state === "CB_REVERSED") && !c.override
      && c.calculated_debit != null && Math.abs(c.debited - c.calculated_debit) > 0.005) {
    out.push(`posted ₹${c.debited.toFixed(2)}, the rule calculated ₹${c.calculated_debit.toFixed(2)}`);
  }
  return out;
}
