// What a merchant or banker is shown of a chargeback, and what staff are.
//
// PURE. A merchant never sees who sent the record (it may be a gateway), who at Katana handled
// it, or a person's note: the explanation is built from the figures instead, and the reason
// text has gateway names stripped (lib/merchant-safe).

import type { ChargebackRow, CbPosting, CbEvent } from "@/lib/chargebacks-store";
import { CB_LABEL, CB_OPEN, type CbState } from "@/lib/chargeback-rules";
import { stripGatewayNames } from "@/lib/merchant-safe";
import { payinChannelOf, type PayinChannel } from "@/lib/payin-channel";

const SOURCE_WORDS: Record<string, string> = {
  BANK: "Bank", ACQUIRER: "Acquiring bank", GATEWAY: "Payment processor", SETTLEMENT_FILE: "Settlement file", OTHER: "Bank",
};

const money = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (bps: number | null) => (bps == null ? null : `${(bps / 100).toFixed(2).replace(/\.00$/, "")}%`);

/** The state in words a merchant can act on, built only from the figures. */
export function merchantExplanation(c: Pick<ChargebackRow, "state" | "amount" | "debited" | "reversed" | "debit_bps" | "order_id">): string {
  const net = Math.round((c.debited - c.reversed) * 100) / 100;
  switch (c.state) {
    case "CB_PENDING_MATCH": return "Katana is finding the payment this chargeback is about. Nothing is debited until it is found.";
    case "CB_MANUAL_REVIEW": return "Katana is reviewing this chargeback. Nothing is debited until the review is done.";
    case "CB_RULE_EXCEPTION": return "Katana is confirming the terms for this chargeback. Nothing is debited yet.";
    case "CB_MATCHED": return "Matched to your payment. Nothing is debited under your terms.";
    case "CB_DEBIT_POSTED":
    case "CB_PARTIAL_DEBIT":
      return `${money(c.debited)} debited of the ${money(c.amount)} chargeback${c.debit_bps != null ? ` (${pct(c.debit_bps)} under your terms)` : ""}`
        + `${c.reversed > 0 ? `; ${money(c.reversed)} given back, ${money(net)} net` : ""}.`;
    case "CB_REVERSED": return `The ${money(c.debited)} debit was given back in full.`;
    case "CB_DISMISSED": return "Closed: not a chargeback against this payment. Nothing was debited.";
  }
}

export interface MerchantChargeback {
  id: string; cb_ref: string; source: string; bank_ref: string; original_ref: string | null;
  order_ref: string | null; order_date: string | null; order_amount: number | null; order_utr: string | null;
  banker: string | null; channel: PayinChannel | null;
  amount: number; currency: string; reason_code: string | null; reason: string | null; event_date: string | null; received_at: string;
  debit_ratio: string | null; calculated_debit: number | null; debited: number; reversed: number; net_debited: number;
  remaining_exposure: number;
  state: CbState; state_label: string; explanation: string; reconciled: boolean;
}

export function merchantChargeback(c: ChargebackRow, problems: string[]): MerchantChargeback {
  const net = Math.round((c.debited - c.reversed) * 100) / 100;
  return {
    id: c.id, cb_ref: c.cb_ref, source: SOURCE_WORDS[c.source] ?? "Bank", bank_ref: c.bank_ref, original_ref: c.original_ref,
    order_ref: c.order_ref, order_date: c.order_created_at, order_amount: c.order_amount, order_utr: c.order_utr,
    banker: c.merchant_id, channel: c.channel_type ? payinChannelOf(c.channel_type) : null,
    amount: c.amount, currency: c.currency, reason_code: c.reason_code,
    reason: c.reason_text ? stripGatewayNames(c.reason_text, "payment processor") : null,
    event_date: c.event_date, received_at: c.received_at,
    debit_ratio: pct(c.debit_bps), calculated_debit: c.calculated_debit,
    debited: c.debited, reversed: c.reversed, net_debited: net,
    // What may still be debited: the whole chargeback while it is open, nothing once decided.
    remaining_exposure: CB_OPEN.includes(c.state) ? (c.calculated_debit ?? c.amount) : 0,
    state: c.state, state_label: CB_LABEL[c.state], explanation: merchantExplanation(c),
    reconciled: problems.length === 0,
  };
}

export interface StaffChargeback extends MerchantChargeback {
  source_raw: string; source_name: string | null; stated_order: string | null; stated_banker: string | null;
  stated_channel: string | null; order_id: string | null; provider_id: string | null; match_method: string | null;
  matched_at: string | null; matched_by: string | null; rule_id: string | null; rule_version: number | null;
  state_note: string | null; received_by: string | null; livemode: boolean; problems: string[]; override: boolean;
}

export function staffChargeback(c: ChargebackRow, problems: string[]): StaffChargeback {
  return {
    ...merchantChargeback(c, problems),
    reason: c.reason_text,
    source_raw: c.source, source_name: c.source_name, stated_order: c.stated_order, stated_banker: c.stated_banker,
    stated_channel: c.stated_channel, order_id: c.order_id, provider_id: c.provider_id, match_method: c.match_method,
    matched_at: c.matched_at, matched_by: c.matched_by, rule_id: c.rule_id, rule_version: c.rule_version,
    state_note: c.state_note, received_by: c.received_by, livemode: c.livemode, problems, override: c.override,
  };
}

/** The chain as a merchant sees it: what happened, without who at Katana did it. */
export function merchantChain(postings: CbPosting[], events: CbEvent[]) {
  return {
    postings: postings.map((p) => ({
      kind: p.kind, amount: p.amount, at: p.created_at,
      basis: p.kind === "CHARGEBACK_DEBIT"
        ? (p.debit_bps != null ? `${pct(p.debit_bps)} of the chargeback under your terms (version ${p.rule_version})` : "Set by Katana on review")
        : "Given back",
    })),
    events: events.map((e) => ({ to_state: e.to_state, label: CB_LABEL[e.to_state as CbState] ?? e.to_state, at: e.at })),
  };
}
