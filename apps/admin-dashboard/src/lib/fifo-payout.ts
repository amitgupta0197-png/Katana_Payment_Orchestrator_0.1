// FIFO payout + beneficiary registry + maker-checker (Katana BRD §18, §9, §11.B,
// FR-007). Payout orders reuse fifo_orders (direction='PAYOUT'); they validate an
// APPROVED (whitelisted) beneficiary, check the merchant's payable balance, and
// route high-value requests through a maker-checker approval before queuing.
// A merchant with PayU Payouts credentials is paid out through PayU (lib/payu-payout-order)
// instead of the operator queue, limited by their PayU balance rather than the ledger.

import { rows } from "@/lib/pg";
import { randomBytes } from "crypto";
import { postJournal } from "@/lib/ledger";
import { transition, recordEvent, recordFraudAlert } from "@/lib/fifo";
import { isAllowedNetwork, lockUsdtRate, computeUsdtAmount, ALLOWED_USDT_NETWORKS } from "@/lib/fifo-usdt";
import { finalizeSettlementBatch, rejectSettlementBatch } from "@/lib/fifo-settlement";
import { getPayuPayoutCreds, payuPayoutBalance, type PayoutRail } from "@/lib/payu-payout";
import { dispatchPayuPayout } from "@/lib/payu-payout-order";
import { sendPayoutCallback } from "@/lib/payout-api";
import { checkPayoutPolicy, getPayoutPolicy, isMerchantSuspended } from "@/lib/payout-policy";

// High-value payouts (>= this, in minor units) require maker-checker approval.
export const HIGH_VALUE_PAYOUT_MINOR = BigInt(process.env.FIFO_HIGH_VALUE_PAYOUT_MINOR ?? "5000000"); // ₹50,000

export function maskAccount(acct?: string | null): { masked: string | null; last4: string | null } {
  if (!acct) return { masked: null, last4: null };
  const last4 = acct.slice(-4);
  return { masked: acct.length <= 4 ? acct : "•".repeat(acct.length - 4) + last4, last4 };
}

// Merchant payable balance (minor units): credits - debits on MERCHANT_PAYABLE.
export async function merchantPayableMinor(merchantId: string): Promise<bigint> {
  const r = (await rows<{ bal: string }>("ledger", `
    SELECT COALESCE(SUM(CASE WHEN ll.side='C' THEN ll.amount_minor ELSE -ll.amount_minor END),0)::text AS bal
      FROM ledger_lines ll JOIN accounts a ON a.id = ll.account_id
     WHERE a.code = $1
  `, [`LIABILITIES.MERCHANT_PAYABLE.${merchantId}`]).catch(() => []))[0];
  try { return BigInt(r?.bal ?? "0"); } catch { return 0n; }
}

export interface CreateBeneficiaryInput {
  merchantId: string; beneficiaryName: string; bankName?: string; accountNumber?: string;
  ifsc?: string; upiId?: string; walletAddress?: string; network?: string; createdBy?: string;
  /** Merchant's own reference (API registrations); unique per merchant. */
  merchantRef?: string;
}

export async function createBeneficiary(input: CreateBeneficiaryInput): Promise<{ id: string }> {
  const { last4 } = maskAccount(input.accountNumber);
  const r = (await rows<{ id: string }>("fifo", `
    INSERT INTO fifo_beneficiaries
      (merchant_id, beneficiary_name, bank_name, account_number, account_last4, ifsc, upi_id, wallet_address, network, created_by, merchant_ref)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id::text
  `, [input.merchantId, input.beneficiaryName, input.bankName ?? null, input.accountNumber ?? null, last4,
      input.ifsc ?? null, input.upiId ?? null, input.walletAddress ?? null, input.network ?? null, input.createdBy ?? null,
      input.merchantRef ?? null]))[0];

  // Maker-checker record (BRD §9). Wallet adds are the more sensitive USDT path.
  await rows("fifo", `
    INSERT INTO fifo_approvals (action_type, resource_type, resource_id, merchant_id, detail, maker)
    VALUES ($1,'beneficiary',$2,$3,$4,$5)
  `, [input.walletAddress ? "USDT_WALLET_CHANGE" : "BENEFICIARY_ADD", r.id, input.merchantId,
      `Add beneficiary ${input.beneficiaryName}`, input.createdBy ?? null]).catch(() => {});
  return r;
}

// Checker decision on a beneficiary (approve = whitelist).
export async function decideBeneficiary(id: string, approve: boolean, checker: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
  const b = (await rows<any>("fifo", `SELECT id::text, status, created_by FROM fifo_beneficiaries WHERE id=$1::uuid`, [id]))[0];
  if (!b) return { ok: false, error: "beneficiary not found" };
  if (b.status !== "PENDING") return { ok: false, error: `already ${b.status}` };
  // Maker-checker separation (BRD §9): a checker cannot approve their own record.
  if (approve && b.created_by && b.created_by === checker) return { ok: false, error: "maker cannot be checker" };
  const next = approve ? "APPROVED" : "REJECTED";
  await rows("fifo", `UPDATE fifo_beneficiaries SET status=$2, approved_by=$3, approved_at=now() WHERE id=$1::uuid`, [id, next, checker]);
  await rows("fifo", `UPDATE fifo_approvals SET status=$2, checker=$3, reason=$4, decided_at=now() WHERE resource_id=$1 AND status='PENDING'`,
    [id, approve ? "APPROVED" : "REJECTED", checker, reason ?? null]).catch(() => {});
  return { ok: true };
}

export interface CreatePayoutInput {
  merchantId: string; beneficiaryId: string; amountMinor: bigint; currency: string;
  settlementMode?: string; purpose?: string; actor?: string | null;
  /** Bank rail for a provider payout; picked from the beneficiary when absent. */
  rail?: PayoutRail;
  /** Caller's idempotency key: a repeat returns the first payout instead of paying twice. */
  merchantTxnId?: string;
  /** Set by the merchant API from the key's mode. A test payout must go to PayU UAT. */
  livemode?: boolean;
  /** Where the signed status callback goes; else the merchant's webhook URL. */
  callbackUrl?: string;
}

// RBI rail limits (paise). PayU applies its own on top.
const RTGS_MIN_MINOR = 20_000_000n;   // ₹2,00,000
const IMPS_MAX_MINOR = 50_000_000n;   // ₹5,00,000

// A repeated merchant_txn_id returns the first payout, but only if it is the same request.
async function existingPayout(input: CreatePayoutInput): Promise<{ order?: any; error?: string; status?: number } | null> {
  const p = (await rows<any>("fifo", `
    SELECT id::text, order_ref, status, provider, failure_reason, amount_minor::text, beneficiary_id::text, livemode
      FROM fifo_orders WHERE merchant_id=$1 AND merchant_txn_id=$2 AND direction='PAYOUT'
  `, [input.merchantId, input.merchantTxnId]))[0];
  if (!p) return null;
  if (p.amount_minor !== input.amountMinor.toString() || p.beneficiary_id !== input.beneficiaryId
      || (input.livemode !== undefined && p.livemode !== input.livemode))
    return { error: `txnid ${input.merchantTxnId} was already used for a different payout (${p.order_ref})`, status: 409 };
  const { amount_minor: _a, beneficiary_id: _b, livemode: _l, ...order } = p;
  return { order: { ...order, idempotent: true } };
}

// Which rail a PayU payout goes on, or why it can't go.
function pickRail(b: { account_number: string | null; ifsc: string | null; upi_id: string | null }, amountMinor: bigint, asked?: PayoutRail): { rail?: PayoutRail; error?: string } {
  const hasBank = !!(b.account_number && b.ifsc);
  const rail = asked ?? (hasBank ? "IMPS" : b.upi_id ? "UPI" : undefined);
  if (!rail) return { error: "beneficiary has neither a bank account + IFSC nor a UPI ID" };
  if (rail === "UPI" && !b.upi_id) return { error: "beneficiary has no UPI ID" };
  if (rail !== "UPI" && !hasBank) return { error: `beneficiary needs an account number and IFSC for ${rail}` };
  if (rail === "RTGS" && amountMinor < RTGS_MIN_MINOR) return { error: "RTGS needs at least ₹2,00,000" };
  if (rail === "IMPS" && amountMinor > IMPS_MAX_MINOR) return { error: "IMPS allows at most ₹5,00,000; use NEFT or RTGS" };
  return { rail };
}

export async function createPayout(input: CreatePayoutInput): Promise<{ order?: any; error?: string; status?: number }> {
  if (input.amountMinor <= 0n) return { error: "amount must be > 0", status: 400 };

  if (input.merchantTxnId) {
    const prior = await existingPayout(input);
    if (prior) return prior;
  }

  if (await isMerchantSuspended(input.merchantId))
    return { error: "payouts are suspended for this merchant", status: 403 };

  // Beneficiary must exist, belong to the merchant, and be APPROVED (whitelisted).
  const b = (await rows<any>("fifo", `
    SELECT id::text, status, beneficiary_name, wallet_address, network, account_number, ifsc, upi_id FROM fifo_beneficiaries
     WHERE id=$1::uuid AND merchant_id=$2
  `, [input.beneficiaryId, input.merchantId]))[0];
  if (!b) return { error: "beneficiary not found for merchant", status: 404 };
  if (b.status !== "APPROVED") return { error: `beneficiary not whitelisted (status=${b.status})`, status: 409 };

  const mode = (input.settlementMode ?? (b.wallet_address ? "USDT" : "BANK")).toUpperCase();

  // A merchant with PayU Payouts credentials pays from their own PayU account: PayU's
  // balance is the limit, not Katana's payable ledger (which PayU pay-ins don't credit).
  const payu = mode === "USDT" ? null : await getPayuPayoutCreds(input.merchantId);
  // A test key must never move real money: it needs PayU UAT credentials, and a live key
  // must not land in PayU's sandbox.
  if (input.livemode === false && payu?.env !== "TEST")
    return { error: "test payouts need PayU UAT (TEST) payout credentials for this merchant", status: 409 };
  if (input.livemode === true && payu && payu.env !== "PROD")
    return { error: "this merchant's PayU payout credentials are TEST; use a test key", status: 409 };

  const policy = await getPayoutPolicy(input.merchantId);
  const livemode = payu ? payu.env === "PROD" : true;
  let rail: PayoutRail | undefined;
  if (payu) {
    if (input.currency !== "INR") return { error: "PayU payouts are INR only", status: 400 };
    // Without an explicit rail, take the first of the merchant's allowed rails this beneficiary
    // and amount can use; with no such rail, the default pick explains what's wrong.
    const fitting = input.rail ? undefined
      : policy.allowed_rails?.find((r) => !pickRail(b, input.amountMinor, r).error);
    const picked = pickRail(b, input.amountMinor, input.rail ?? fitting);
    if (picked.error) return { error: picked.error, status: 409 };
    rail = picked.rail;
  }
  const policyError = await checkPayoutPolicy(policy, input.amountMinor, rail, livemode);
  if (policyError) return { error: policyError, status: 409 };

  if (payu) {
    // If PayU can't be asked, carry on: PayU itself holds a payout it can't fund.
    const bal = await payuPayoutBalance(payu);
    if (bal.ok && bal.data.balanceMinor < input.amountMinor)
      return { error: `insufficient PayU payout balance (have ${bal.data.balanceMinor}, need ${input.amountMinor})`, status: 409 };
  } else {
    if (input.rail) return { error: "rail applies only to PayU payouts; this merchant has no PayU payout credentials", status: 400 };
    // Balance + reserve check (BRD §18).
    const payable = await merchantPayableMinor(input.merchantId);
    if (input.amountMinor > payable)
      return { error: `insufficient payable balance (have ${payable}, need ${input.amountMinor})`, status: 409 };
  }

  const orderRef = "PO-" + randomBytes(6).toString("hex").toUpperCase();
  const txnRef = "TXN-" + randomBytes(8).toString("hex").toUpperCase();

  // USDT settlement controls (BRD §11.C, §22, FR-008): network whitelist + wallet
  // (already APPROVED) + locked rate. Computed USDT amount stored on the order.
  let usdt: { network: string; rate: number; source: string; lockedAt: string; amount: number } | null = null;
  if (mode === "USDT") {
    if (!b.wallet_address) return { error: "beneficiary has no USDT wallet", status: 409 };
    if (!isAllowedNetwork(b.network)) return { error: `network ${b.network ?? "?"} not allowed (${ALLOWED_USDT_NETWORKS.join("/")})`, status: 409 };
    const lock = await lockUsdtRate();
    usdt = { network: b.network.toUpperCase(), rate: lock.rate, source: lock.source, lockedAt: lock.lockedAt, amount: computeUsdtAmount(input.amountMinor, lock.rate) };
  }

  let o: any;
  try {
    o = (await rows<any>("fifo", `
      INSERT INTO fifo_orders
        (order_ref, merchant_id, direction, amount_minor, currency, settlement_mode, purpose, txn_ref, beneficiary_id, status,
         usdt_network, usdt_rate, usdt_rate_source, usdt_rate_locked_at, usdt_amount,
         provider, payout_rail, merchant_txn_id, livemode, callback_url)
      VALUES ($1,$2,'PAYOUT',$3,$4,$5,$6,$7,$8::uuid,'CREATED',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING id::text, order_ref
    `, [orderRef, input.merchantId, input.amountMinor.toString(), input.currency,
        rail === "UPI" ? "UPI" : mode, input.purpose ?? null, txnRef, input.beneficiaryId,
        usdt?.network ?? null, usdt?.rate ?? null, usdt?.source ?? null, usdt?.lockedAt ?? null, usdt?.amount ?? null,
        payu ? "PAYU" : null, rail ?? null, input.merchantTxnId ?? null, livemode,
        input.callbackUrl ?? null]))[0];
  } catch (err) {
    // Two requests with the same merchant_txn_id raced; the loser returns the winner's payout.
    if ((err as { code?: string }).code === "23505" && input.merchantTxnId) {
      const prior = await existingPayout(input);
      if (prior) return prior;
    }
    throw err;
  }
  await recordEvent({ orderId: o.id, from: null, to: "CREATED", actor: input.actor, reason: `payout to ${b.beneficiary_name}`, payload: usdt ? { usdt } : undefined });
  await transition({ orderId: o.id, to: "VALIDATED", reason: "beneficiary whitelisted + balance ok", actor: input.actor });

  // High-value payouts, and every payout of a MAKER_CHECKER merchant, wait for a second person.
  const highValue = input.amountMinor >= HIGH_VALUE_PAYOUT_MINOR;
  if (highValue || policy.approval_rule === "MAKER_CHECKER") {
    await transition({ orderId: o.id, to: "HOLD", actorKind: "system", reason: highValue
      ? `high-value payout — awaiting maker-checker (>= ${HIGH_VALUE_PAYOUT_MINOR})`
      : "merchant policy: every payout needs maker-checker approval" });
    await rows("fifo", `
      INSERT INTO fifo_approvals (action_type, resource_type, resource_id, order_ref, merchant_id, amount_minor, currency, detail, maker)
      VALUES ('PAYOUT_HIGH_VALUE','order',$1,$2,$3,$4,$5,$6,$7)
    `, [o.id, o.order_ref, input.merchantId, input.amountMinor.toString(), input.currency, `Payout ${input.amountMinor} to ${b.beneficiary_name}`, input.actor ?? null]).catch(() => {});
    if (highValue) await recordFraudAlert({ orderId: o.id, orderRef: o.order_ref, merchantId: input.merchantId, type: "HIGH_VALUE", severity: "MEDIUM", detail: `High-value payout pending approval` });
    return { order: { id: o.id, order_ref: o.order_ref, status: "HOLD", approval_required: true, usdt } };
  }

  // PayU payouts go straight to PayU; the rest wait for an operator.
  if (payu) {
    await transition({ orderId: o.id, to: "QUEUED", reason: "released to PayU", actor: input.actor });
    await rows("fifo", `UPDATE fifo_orders SET queued_at=now() WHERE id=$1::uuid`, [o.id]).catch(() => {});
    const d = await dispatchPayuPayout(o.id);
    return { order: { id: o.id, order_ref: o.order_ref, status: d.status, provider: "PAYU", rail, approval_required: false, error: d.error } };
  }
  await transition({ orderId: o.id, to: "QUEUED", reason: "added to FIFO payout queue", actor: input.actor });
  await rows("fifo", `UPDATE fifo_orders SET queued_at=now() WHERE id=$1::uuid`, [o.id]).catch(() => {});
  await rows("fifo", `INSERT INTO fifo_queue (order_id, priority, status) VALUES ($1::uuid, 0, 'QUEUED') ON CONFLICT (order_id) DO NOTHING`, [o.id]);
  return { order: { id: o.id, order_ref: o.order_ref, status: "QUEUED", approval_required: false, usdt } };
}

// Checker decides a pending approval (maker-checker, BRD §9). On approval of a
// high-value payout the order is released from HOLD into the queue.
export async function decideApproval(id: string, approve: boolean, checker: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
  const a = (await rows<any>("fifo", `SELECT id::text, action_type, resource_id, order_ref, status, maker FROM fifo_approvals WHERE id=$1::uuid`, [id]))[0];
  if (!a) return { ok: false, error: "approval not found" };
  if (a.status !== "PENDING") return { ok: false, error: `already ${a.status}` };
  if (approve && a.maker && a.maker === checker) return { ok: false, error: "maker cannot be checker" };

  await rows("fifo", `UPDATE fifo_approvals SET status=$2, checker=$3, reason=$4, decided_at=now() WHERE id=$1::uuid`,
    [id, approve ? "APPROVED" : "REJECTED", checker, reason ?? null]);

  if (a.action_type === "PAYOUT_HIGH_VALUE" && a.resource_id) {
    const merchant = (await rows<{ merchant_id: string }>("fifo", `SELECT merchant_id FROM fifo_orders WHERE id=$1::uuid`, [a.resource_id]))[0];
    if (approve && merchant && await isMerchantSuspended(merchant.merchant_id)) {
      // Suspended while the payout waited: nothing new goes out.
      await transition({ orderId: a.resource_id, to: "REJECTED", actor: checker, actorKind: "admin", reason: "merchant suspended while the payout awaited approval" });
      await rows("fifo", `UPDATE fifo_orders SET failure_reason='payouts are suspended for this merchant' WHERE id=$1::uuid`, [a.resource_id]).catch(() => {});
      await sendPayoutCallback(a.resource_id);
    } else if (approve) {
      await transition({ orderId: a.resource_id, to: "QUEUED", actor: checker, actorKind: "admin", reason: "high-value payout approved" });
      await rows("fifo", `UPDATE fifo_orders SET queued_at=now() WHERE id=$1::uuid`, [a.resource_id]).catch(() => {});
      const o = (await rows<{ provider: string | null }>("fifo", `SELECT provider FROM fifo_orders WHERE id=$1::uuid`, [a.resource_id]))[0];
      if (o?.provider === "PAYU") await dispatchPayuPayout(a.resource_id);
      else await rows("fifo", `INSERT INTO fifo_queue (order_id, priority, status) VALUES ($1::uuid, 1, 'QUEUED') ON CONFLICT (order_id) DO NOTHING`, [a.resource_id]);
    } else {
      await transition({ orderId: a.resource_id, to: "REJECTED", actor: checker, actorKind: "admin", reason: reason ?? "payout rejected by checker" });
      await sendPayoutCallback(a.resource_id);
    }
  } else if ((a.action_type === "BENEFICIARY_ADD" || a.action_type === "USDT_WALLET_CHANGE") && a.resource_id) {
    await rows("fifo", `UPDATE fifo_beneficiaries SET status=$2, approved_by=$3, approved_at=now() WHERE id=$1::uuid AND status='PENDING'`,
      [a.resource_id, approve ? "APPROVED" : "REJECTED", checker]).catch(() => {});
  } else if (a.action_type === "SETTLEMENT_RELEASE" && a.resource_id) {
    if (approve) await finalizeSettlementBatch(a.resource_id, checker);
    else await rejectSettlementBatch(a.resource_id);
  } else if (a.action_type === "RECON_ADJUSTMENT" && a.resource_id) {
    // Resolve the reconciliation item; the reason code lives on the approval.
    if (approve) await rows("fifo", `UPDATE fifo_recon_items SET resolved=true WHERE id=$1::uuid`, [a.resource_id]).catch(() => {});
  }
  return { ok: true };
}

// Post a completed PAYOUT to the ledger (BRD §20): debit merchant payable, credit
// the settlement clearing account. Idempotent on txn_ref.
export async function settlePayoutToLedger(input: {
  merchantId: string; txnRef: string; amountMinor: bigint; currency: string; provider?: string;
}): Promise<string | null> {
  const provider = (input.provider || "BANK").toUpperCase();
  try {
    const j = await postJournal({
      journal_type: "payout.disbursed",
      narration: `FIFO payout ${input.txnRef} via ${provider}`,
      currency: input.currency, merchant_id: input.merchantId,
      ref: { type: "payout", id: input.txnRef },
      idempotency_key: `payout.disbursed:${input.txnRef}`,
      lines: [
        { account_code: `LIABILITIES.MERCHANT_PAYABLE.${input.merchantId}`, account_type: "LIABILITY", side: "D", amount_minor: input.amountMinor, currency: input.currency },
        { account_code: `ASSETS.PAYOUT_CLEARING.${provider}`, account_type: "ASSET", side: "C", amount_minor: input.amountMinor, currency: input.currency },
      ],
    });
    return j.journal_id;
  } catch { return null; }
}
