// A payment told as a short story in plain sentences, for the portals' search (lib/payment-search)
// and anything else a merchant reads: when the order was made, what happened to it, whether the
// money arrived and was linked, and whether their server was told. PURE.
//
//   "Order GL-1007 for Rs 499 was made at 5:01 AM."
//   "It expired at 5:16 AM because no payment came in time."
//   "Rs 499 arrived at 5:19 AM (UTR 512345678901), after the order expired, and was not linked to it."
//   "Send the UTR to Katana support so they can check it."

import { istTime, rupees } from "@/lib/plain-words";

export type QueryKind = "utr" | "phone" | "amount" | "reference";

/** What a pasted text probably is. Short numbers may be an amount or a txnid: both are tried. */
export function classifyQuery(raw: string): { kinds: QueryKind[]; value: string; amount: number | null } {
  const q = raw.trim();
  const digits = q.replace(/[\s-]/g, "");
  if (/^\d{12}$/.test(digits)) return { kinds: ["utr", "reference"], value: digits, amount: null };
  const phone = digits.replace(/^(\+?91)(?=[6-9]\d{9}$)/, "");
  if (/^[6-9]\d{9}$/.test(phone)) return { kinds: ["phone", "reference"], value: phone, amount: null };
  const money = /^(?:rs\.?|₹|inr)?\s*(\d{1,3}(?:,\d{2,3})+|\d{1,7})(\.\d{1,2})?$/i.exec(q);
  if (money) {
    const amount = Number((money[1] + (money[2] ?? "")).replace(/,/g, ""));
    const plainNumber = /^\d+$/.test(q);
    return { kinds: plainNumber ? ["amount", "reference"] : ["amount"], value: q, amount };
  }
  return { kinds: ["reference"], value: q, amount: null };
}

export interface StoryOrder {
  txnid: string; amount: number; status: "PENDING" | "SUCCESS" | "FAILED" | "EXPIRED";
  created_at: string; expires_at?: string | null; paid_at?: string | null; livemode: boolean;
  rrn?: string | null; rrn_is_synthetic?: boolean;
}
export interface StoryStep { at: string; from: string | null; to: string; label?: string }
export interface StoryCredit { amount: number; utr: string | null; paid_at: string; linked: boolean }
export interface StoryDelivery {
  status: string; next_attempt_at?: string | null;
  attempts: { at: string; http_status: number | null; error: string | null }[];
}

function lastAnswer(a: { http_status: number | null; error: string | null }): string {
  return a.http_status ? `it answered ${a.http_status}` : "it did not answer";
}

/** The order's story, oldest first. `credits` are payments of the same amount seen near it. */
export function orderStory(o: StoryOrder, steps: StoryStep[], credits: StoryCredit[], deliveries: StoryDelivery[], now = new Date()): string[] {
  const t = (d: string | null | undefined) => istTime(d, now);
  const out: string[] = [`${o.livemode ? "Order" : "Test order"} ${o.txnid} for ${rupees(o.amount)} was made at ${t(o.created_at)}.`];
  const at = (to: string) => steps.filter((s) => s.to === to).map((s) => s.at).sort().pop() ?? null;
  const expiredAt = at("EXPIRED") ?? (o.status === "EXPIRED" ? o.expires_at ?? null : null);
  const failedAt = at("FAILED");
  const late = credits.filter((c) => !c.linked);

  if (o.status === "SUCCESS") {
    const wasLost = steps.some((s) => s.to === "SUCCESS" && (s.from === "EXPIRED" || s.from === "FAILED"));
    if (wasLost && (expiredAt || failedAt)) out.push(`It ${expiredAt ? "expired" : "failed"} at ${t(expiredAt ?? failedAt)}, then the money came in late and it was marked paid at ${t(o.paid_at ?? at("SUCCESS"))}.`);
    else out.push(`It was paid at ${t(o.paid_at ?? at("SUCCESS"))}.`);
    if (o.rrn && !o.rrn_is_synthetic) out.push(`Bank reference (UTR): ${o.rrn}.`);
  } else if (o.status === "EXPIRED") {
    out.push(`It expired${expiredAt ? ` at ${t(expiredAt)}` : ""} because no payment came in time.`);
  } else if (o.status === "FAILED") {
    out.push(`The payment failed${failedAt ? ` at ${t(failedAt)}` : ""}.`);
  } else {
    out.push(o.expires_at ? `It is waiting for the customer to pay, until ${t(o.expires_at)}.` : "It is waiting for the customer to pay.");
  }

  if (o.status !== "SUCCESS") {
    for (const c of late.slice(0, 2)) {
      const when = expiredAt && c.paid_at > expiredAt ? ", after the order expired," : "";
      out.push(`${rupees(c.amount)} arrived at ${t(c.paid_at)}${c.utr ? ` (UTR ${c.utr})` : ""}${when} and was not linked to this order.`);
    }
    if (late.length) out.push("Send the UTR to Katana support so they can check it.");
    else if (o.status !== "PENDING" && o.livemode) out.push("We have not seen this money arrive in your account.");
  }

  const d = deliveries[0];
  if (d) {
    const last = d.attempts[d.attempts.length - 1];
    const retry = d.next_attempt_at && new Date(d.next_attempt_at) > now ? ` We will try again at ${t(d.next_attempt_at)}.` : "";
    if (d.status === "DELIVERED") out.push(`We told your server at ${t(last?.at)}${last?.http_status ? ` (it answered ${last.http_status})` : ""}.`);
    else if (d.status === "DEAD_LETTER") out.push(`We could not tell your server about it. We stopped after ${d.attempts.length} tries${last ? ` (${lastAnswer(last)})` : ""}.`);
    else if (last) out.push(`We have not been able to tell your server yet (${lastAnswer(last)}).${retry}`);
  } else if (o.status !== "PENDING") {
    out.push("No message was sent to your server for this order.");
  }
  return out;
}

/** Money seen arriving that no order explains. */
export function creditStory(c: StoryCredit & { order_txnid?: string | null }, now = new Date()): string[] {
  const out = [`${rupees(c.amount)} arrived at ${istTime(c.paid_at, now)}${c.utr ? ` (UTR ${c.utr})` : ""}.`];
  if (c.linked && c.order_txnid) out.push(`It was linked to order ${c.order_txnid}.`);
  else if (!c.linked) out.push("It is not linked to any order. If a customer paid for an order with it, send the UTR to Katana support.");
  return out;
}
