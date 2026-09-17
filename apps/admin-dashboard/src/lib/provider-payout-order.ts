// Provider payout orders — how a whitelisted, approved payout becomes a transfer at the
// merchant's payout gateway (PayU, RazorpayX, Cashfree, Paytm) and how the gateway's answer
// closes it. Gateway specifics live in lib/payout-providers; the rules live here, once.
//
//   dispatchProviderPayout  QUEUED -> SUBMITTED, then asks the gateway to pay. A definite
//                           refusal fails the order; no answer leaves it SUBMITTED for the sweep.
//   syncProviderPayout      asks the gateway what happened (status lookup) and applies it. The
//                           webhooks, the sweep and the admin "check now" all come through here,
//                           so a webhook body is never trusted on its own.
//
// Every move is a guarded UPDATE ... WHERE status=<from>, so a webhook and the sweep landing
// together move the order once and fire one merchant callback.
//
// No ledger posting: the money sits in the merchant's own gateway account and never passed
// through Katana's books (unlike operator-paid payouts, which debit MERCHANT_PAYABLE).

import { rows } from "@/lib/pg";
import { recordEvent, recordFraudAlert } from "@/lib/fifo";
import { sendPayoutCallback } from "@/lib/payout-api";
import { isMerchantSuspended } from "@/lib/payout-policy";
import { gatewayName } from "@/lib/pg-catalog";
import { payoutConnector, prodEnabled, providerCreds, type PayoutRail, type TransferState } from "@/lib/payout-providers";

export interface ProviderPayoutOrder {
  id: string; order_ref: string; txn_ref: string; merchant_id: string;
  amount_minor: string; currency: string; status: string; provider: string;
  payout_rail: PayoutRail | null; purpose: string | null; beneficiary_id: string | null;
  callback_url: string | null; utr: string | null; provider_ref: string | null; created_at: Date;
}

export const PROVIDER_ORDER_COLS = `id::text, order_ref, txn_ref, merchant_id, amount_minor::text, currency, status, provider,
  payout_rail, purpose, beneficiary_id::text, callback_url, utr, provider_ref, created_at`;

/** A payout sent (or to be sent) through a gateway. `provider` narrows it to one gateway. */
export async function loadProviderPayout(where: "id" | "txn_ref" | "provider_ref", value: string, provider?: string): Promise<ProviderPayoutOrder | null> {
  const cond = where === "id" ? "id=$1::uuid" : `${where}=$1`;
  const args: unknown[] = [value];
  let prov = "provider IS NOT NULL";
  if (provider) { args.push(provider); prov = "provider=$2"; }
  return (await rows<ProviderPayoutOrder>("fifo",
    `SELECT ${PROVIDER_ORDER_COLS} FROM fifo_orders WHERE ${cond} AND direction='PAYOUT' AND ${prov} LIMIT 1`,
    args).catch(() => []))[0] ?? null;
}

const nameOf = (o: ProviderPayoutOrder) => gatewayName(o.provider);

// Guarded move: only succeeds if the order is still in `from`. Returns false if someone
// else moved it first — the caller then does nothing more (no second callback).
async function moveIf(o: ProviderPayoutOrder, from: string, to: string, reason: string,
  set: Record<string, string | null> = {}, payload?: Record<string, unknown>): Promise<boolean> {
  const sets = ["status=$3"]; const args: unknown[] = [o.id, from, to];
  if (to === "COMPLETED") sets.push("completed_at=now()");
  for (const [k, v] of Object.entries(set)) { args.push(v); sets.push(`${k}=$${args.length}`); }
  const r = await rows<{ id: string }>("fifo",
    `UPDATE fifo_orders SET ${sets.join(", ")} WHERE id=$1::uuid AND status=$2 RETURNING id::text`, args);
  if (!r.length) return false;
  await recordEvent({ orderId: o.id, from, to, actorKind: "gateway", reason, payload });
  return true;
}

async function note(o: ProviderPayoutOrder, reason: string, payload?: Record<string, unknown>) {
  await recordEvent({ orderId: o.id, from: o.status, to: o.status, actorKind: "gateway", reason, payload });
}

export type DispatchResult = { status: string; error?: string };

/** Send a QUEUED provider payout to its gateway. Safe to call twice: only one call wins the QUEUED row. */
export async function dispatchProviderPayout(orderId: string): Promise<DispatchResult> {
  const o = await loadProviderPayout("id", orderId);
  if (!o) return { status: "UNKNOWN", error: "not a provider payout" };
  if (o.status !== "QUEUED") return { status: o.status };
  const name = nameOf(o);

  const ben = (await rows<any>("fifo", `
    SELECT status, beneficiary_name, account_number, ifsc, upi_id FROM fifo_beneficiaries WHERE id=$1::uuid
  `, [o.beneficiary_id]).catch(() => []))[0];
  const active = await providerCreds(o.provider, o.merchant_id);
  // Checked before claiming: these cancel the payout without anything having been sent.
  const blocker = (await isMerchantSuspended(o.merchant_id)) ? "payouts are suspended for this merchant"
    : !active ? `${name} payout credentials are not set for this merchant`
    : active.creds.env === "PROD" && !prodEnabled(active.connector.id) ? `live ${name} payouts are not switched on yet`
    : !active.connector.rails.includes(o.payout_rail ?? "IMPS") ? `${name} can't pay on ${o.payout_rail}`
    : !ben ? "beneficiary no longer exists"
    : ben.status !== "APPROVED" ? `beneficiary is ${ben.status}`
    : null;
  if (blocker) {
    if (await moveIf(o, "QUEUED", "CANCELLED", blocker, { failure_reason: blocker })) await sendPayoutCallback(o.id);
    return { status: "CANCELLED", error: blocker };
  }
  const { connector, creds } = active!;

  if (!(await moveIf(o, "QUEUED", "SUBMITTED", `sent to ${name} (${o.payout_rail})`, { submitted_at: new Date().toISOString() })))
    return { status: (await loadProviderPayout("id", orderId))?.status ?? "UNKNOWN" };
  o.status = "SUBMITTED";

  const t = await connector.transfer(creds, {
    ref: connector.providerRefFor(o.txn_ref), txnRef: o.txn_ref,
    amountMinor: BigInt(o.amount_minor), rail: o.payout_rail ?? "IMPS",
    purpose: o.purpose || "Payout", beneficiaryName: ben.beneficiary_name,
    accountNumber: ben.account_number, ifsc: ben.ifsc, vpa: ben.upi_id,
  });

  if (t.ok) {
    await rows("fifo", `UPDATE fifo_orders SET provider_status=$2, provider_ref=COALESCE($3, provider_ref) WHERE id=$1::uuid`,
      [o.id, t.data.state?.status ?? "ACCEPTED", t.data.providerRef ?? null]).catch(() => {});
    if (t.data.providerRef) o.provider_ref = t.data.providerRef;
    await note(o, `${name} accepted the transfer; waiting for the bank`, t.data.state?.raw ? { provider_raw: t.data.state.raw } : undefined);
    // Some gateways answer with a final state straight away (e.g. rejected on creation).
    // Confirm it with a lookup rather than trusting the create reply alone.
    if (t.data.state?.final) {
      const r = await syncProviderPayout(o, { hint: `CREATE_${t.data.state.status}`, minGapSeconds: 0 });
      return { status: (await loadProviderPayout("id", orderId))?.status ?? "SUBMITTED", error: r.outcome === "failed" ? t.data.state.msg : undefined };
    }
    return { status: "SUBMITTED" };
  }
  if (t.definite) {
    if (await moveIf(o, "SUBMITTED", "FAILED", `${name} refused the transfer: ${t.error}`, { failure_reason: t.error, provider_status: "REJECTED" }))
      await sendPayoutCallback(o.id);
    return { status: "FAILED", error: t.error };
  }
  // The gateway may or may not have the request. The status lookup (by our reference) settles
  // it; sending it again could pay twice.
  await rows("fifo", `UPDATE fifo_orders SET provider_status='UNKNOWN' WHERE id=$1::uuid`, [o.id]).catch(() => {});
  await note(o, `no clear answer from ${name} (${t.error}); the status check will settle it`);
  return { status: "SUBMITTED", error: t.error };
}

export type SyncOutcome =
  | "completed" | "failed" | "reversed" | "pending" | "not_found"
  | "unknown" | "no_creds" | "mismatch" | "final" | "busy";

// Stops a webhook and the sweep from asking the gateway about the same payout at the same moment.
async function claimCheck(orderId: string, minGapSeconds: number): Promise<boolean> {
  const r = await rows<{ id: string }>("fifo", `
    UPDATE fifo_orders SET provider_checked_at=now()
     WHERE id=$1::uuid AND (provider_checked_at IS NULL OR provider_checked_at < now() - ($2 || ' seconds')::interval)
    RETURNING id::text
  `, [orderId, String(minGapSeconds)]).catch(() => []);
  return r.length > 0;
}

/** Ask the gateway about one payout and apply the answer. `hint` is the webhook event, for the record only. */
export async function syncProviderPayout(o: ProviderPayoutOrder, opts: { hint?: string; timeoutMs?: number; minGapSeconds?: number } = {}): Promise<{ outcome: SyncOutcome; detail?: string }> {
  if (o.status !== "SUBMITTED" && o.status !== "COMPLETED") return { outcome: "final" };
  const active = await providerCreds(o.provider, o.merchant_id);
  if (!active) return { outcome: "no_creds" };
  const { connector, creds } = active;
  const name = nameOf(o);
  if (!(await claimCheck(o.id, opts.minGapSeconds ?? 2))) return { outcome: "busy" };

  const r = await connector.status(creds, connector.providerRefFor(o.txn_ref), {
    createdAt: new Date(o.created_at), providerRef: o.provider_ref, timeoutMs: opts.timeoutMs,
  });
  if (!r.ok) return { outcome: "unknown", detail: r.error };
  const s: TransferState = r.data;
  if (!s.found) return { outcome: "not_found" };
  if (opts.hint === "MANUAL_CHECK" && o.status === "SUBMITTED" && !s.final)
    await note(o, `status checked: ${name} says ${s.status}`, { provider_raw: s.raw });

  await rows("fifo", `UPDATE fifo_orders SET provider_status=$2, provider_ref=COALESCE($3, provider_ref) WHERE id=$1::uuid`,
    [o.id, s.status ?? null, s.providerRef ?? null]).catch(() => {});
  // The gateway's answer is kept verbatim on the order timeline (the audit trail for this payout).
  const evidence = {
    provider: o.provider, provider_status: s.status, provider_ref: s.providerRef, bank_ref: s.bankRef,
    msg: s.msg, webhook_event: opts.hint, provider_raw: s.raw,
  };
  const kind = (k: string) => `${o.provider}_PAYOUT_${k}`;

  if (o.status === "SUBMITTED") {
    if (s.final === "SUCCESS") {
      // The gateway's amount must match ours. If it doesn't, something is badly wrong; don't close it.
      if (s.amountMinor != null && s.amountMinor !== BigInt(o.amount_minor)) {
        await recordFraudAlert({
          orderId: o.id, orderRef: o.order_ref, merchantId: o.merchant_id, type: "ANOMALY", severity: "CRITICAL",
          detail: `${name} paid ${s.amountMinor} paise, order is for ${o.amount_minor}`, payload: { kind: kind("AMOUNT_MISMATCH"), ...evidence },
        });
        return { outcome: "mismatch" };
      }
      if (await moveIf(o, "SUBMITTED", "COMPLETED", `${name} confirmed the transfer`, { utr: s.bankRef ?? null }, evidence))
        await sendPayoutCallback(o.id);
      return { outcome: "completed" };
    }
    if (s.final === "FAILED" || s.final === "REVERSED") {
      const why = s.msg ?? `${name} status ${s.status}`;
      if (await moveIf(o, "SUBMITTED", "FAILED", `${name}: ${why}`, { failure_reason: why }, evidence))
        await sendPayoutCallback(o.id);
      return { outcome: "failed" };
    }
    return { outcome: "pending", detail: s.status };
  }

  // COMPLETED: only a reversal can still change it.
  if (s.final === "REVERSED" || s.final === "FAILED") {
    const why = s.msg ?? "bank reversed the transfer";
    if (await moveIf(o, "COMPLETED", "REVERSED", `${name}: ${why}`, { failure_reason: why }, evidence)) {
      await recordFraudAlert({
        orderId: o.id, orderRef: o.order_ref, merchantId: o.merchant_id, type: "ANOMALY", severity: "HIGH",
        detail: `Payout reversed after success: ${why}`, payload: { kind: kind("REVERSED"), ...evidence },
      });
      await sendPayoutCallback(o.id);
    }
    return { outcome: "reversed" };
  }
  if (opts.hint && /REVERS/i.test(opts.hint)) {
    // The webhook says reversed but the lookup still says paid. Don't guess; tell ops.
    await note(o, `${name} webhook reported ${opts.hint} but the status lookup says ${s.status}; left as is`, evidence);
  }
  return { outcome: "final" };
}

/** Raise one ops alert for a payout the gateway still has no record of long after it was sent. */
export async function flagPayoutMissingAtProvider(o: ProviderPayoutOrder): Promise<void> {
  const kind = `${o.provider}_PAYOUT_NOT_FOUND`;
  const exists = (await rows<{ n: number }>("fifo", `
    SELECT COUNT(*)::int AS n FROM fifo_fraud_alerts WHERE order_id=$1::uuid AND payload->>'kind'=$2
  `, [o.id, kind]).catch(() => []))[0]?.n ?? 0;
  if (exists) return;
  const name = nameOf(o);
  const connector = payoutConnector(o.provider);
  await recordFraudAlert({
    orderId: o.id, orderRef: o.order_ref, merchantId: o.merchant_id, type: "ANOMALY", severity: "HIGH",
    detail: `${name} has no record of this payout. Check the ${name} dashboard before paying it another way.`,
    payload: { kind, merchant_ref_id: connector ? connector.providerRefFor(o.txn_ref) : o.txn_ref },
  });
}
