// FIFO payout + beneficiary registry + maker-checker (PayTech BRD §18, §9, §11.B,
// FR-007). Payout orders reuse fifo_orders (direction='PAYOUT'); they validate an
// APPROVED (whitelisted) beneficiary, check the merchant's payable balance, and
// route high-value requests through a maker-checker approval before queuing.

import { rows } from "@/lib/pg";
import { randomBytes } from "crypto";
import { postJournal } from "@/lib/ledger";
import { transition, recordEvent, recordFraudAlert } from "@/lib/fifo";
import { isAllowedNetwork, lockUsdtRate, computeUsdtAmount, ALLOWED_USDT_NETWORKS } from "@/lib/fifo-usdt";
import { finalizeSettlementBatch, rejectSettlementBatch } from "@/lib/fifo-settlement";

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
}

export async function createBeneficiary(input: CreateBeneficiaryInput): Promise<{ id: string }> {
  const { last4 } = maskAccount(input.accountNumber);
  const r = (await rows<{ id: string }>("fifo", `
    INSERT INTO fifo_beneficiaries
      (merchant_id, beneficiary_name, bank_name, account_number, account_last4, ifsc, upi_id, wallet_address, network, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING id::text
  `, [input.merchantId, input.beneficiaryName, input.bankName ?? null, input.accountNumber ?? null, last4,
      input.ifsc ?? null, input.upiId ?? null, input.walletAddress ?? null, input.network ?? null, input.createdBy ?? null]))[0];

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
}

export async function createPayout(input: CreatePayoutInput): Promise<{ order?: any; error?: string; status?: number }> {
  if (input.amountMinor <= 0n) return { error: "amount must be > 0", status: 400 };

  // Beneficiary must exist, belong to the merchant, and be APPROVED (whitelisted).
  const b = (await rows<any>("fifo", `
    SELECT id::text, status, beneficiary_name, wallet_address, network FROM fifo_beneficiaries
     WHERE id=$1::uuid AND merchant_id=$2
  `, [input.beneficiaryId, input.merchantId]))[0];
  if (!b) return { error: "beneficiary not found for merchant", status: 404 };
  if (b.status !== "APPROVED") return { error: `beneficiary not whitelisted (status=${b.status})`, status: 409 };

  // Balance + reserve check (BRD §18).
  const payable = await merchantPayableMinor(input.merchantId);
  if (input.amountMinor > payable)
    return { error: `insufficient payable balance (have ${payable}, need ${input.amountMinor})`, status: 409 };

  const orderRef = "PO-" + randomBytes(6).toString("hex").toUpperCase();
  const txnRef = "TXN-" + randomBytes(8).toString("hex").toUpperCase();
  const mode = (input.settlementMode ?? (b.wallet_address ? "USDT" : "BANK")).toUpperCase();

  // USDT settlement controls (BRD §11.C, §22, FR-008): network whitelist + wallet
  // (already APPROVED) + locked rate. Computed USDT amount stored on the order.
  let usdt: { network: string; rate: number; source: string; lockedAt: string; amount: number } | null = null;
  if (mode === "USDT") {
    if (!b.wallet_address) return { error: "beneficiary has no USDT wallet", status: 409 };
    if (!isAllowedNetwork(b.network)) return { error: `network ${b.network ?? "?"} not allowed (${ALLOWED_USDT_NETWORKS.join("/")})`, status: 409 };
    const lock = await lockUsdtRate();
    usdt = { network: b.network.toUpperCase(), rate: lock.rate, source: lock.source, lockedAt: lock.lockedAt, amount: computeUsdtAmount(input.amountMinor, lock.rate) };
  }

  const o = (await rows<any>("fifo", `
    INSERT INTO fifo_orders
      (order_ref, merchant_id, direction, amount_minor, currency, settlement_mode, purpose, txn_ref, beneficiary_id, status,
       usdt_network, usdt_rate, usdt_rate_source, usdt_rate_locked_at, usdt_amount)
    VALUES ($1,$2,'PAYOUT',$3,$4,$5,$6,$7,$8::uuid,'CREATED',$9,$10,$11,$12,$13)
    RETURNING id::text, order_ref
  `, [orderRef, input.merchantId, input.amountMinor.toString(), input.currency, mode, input.purpose ?? null, txnRef, input.beneficiaryId,
      usdt?.network ?? null, usdt?.rate ?? null, usdt?.source ?? null, usdt?.lockedAt ?? null, usdt?.amount ?? null]))[0];
  await recordEvent({ orderId: o.id, from: null, to: "CREATED", actor: input.actor, reason: `payout to ${b.beneficiary_name}`, payload: usdt ? { usdt } : undefined });
  await transition({ orderId: o.id, to: "VALIDATED", reason: "beneficiary whitelisted + balance ok", actor: input.actor });

  // High-value payouts require maker-checker approval before they can queue.
  if (input.amountMinor >= HIGH_VALUE_PAYOUT_MINOR) {
    await transition({ orderId: o.id, to: "HOLD", actorKind: "system", reason: `high-value payout — awaiting maker-checker (>= ${HIGH_VALUE_PAYOUT_MINOR})` });
    await rows("fifo", `
      INSERT INTO fifo_approvals (action_type, resource_type, resource_id, order_ref, merchant_id, amount_minor, currency, detail, maker)
      VALUES ('PAYOUT_HIGH_VALUE','order',$1,$2,$3,$4,$5,$6,$7)
    `, [o.id, o.order_ref, input.merchantId, input.amountMinor.toString(), input.currency, `Payout ${input.amountMinor} to ${b.beneficiary_name}`, input.actor ?? null]).catch(() => {});
    await recordFraudAlert({ orderId: o.id, orderRef: o.order_ref, merchantId: input.merchantId, type: "HIGH_VALUE", severity: "MEDIUM", detail: `High-value payout pending approval` });
    return { order: { id: o.id, order_ref: o.order_ref, status: "HOLD", approval_required: true, usdt } };
  }

  // Otherwise enqueue for operator/finance execution.
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
    if (approve) {
      await transition({ orderId: a.resource_id, to: "QUEUED", actor: checker, actorKind: "admin", reason: "high-value payout approved" });
      await rows("fifo", `UPDATE fifo_orders SET queued_at=now() WHERE id=$1::uuid`, [a.resource_id]).catch(() => {});
      await rows("fifo", `INSERT INTO fifo_queue (order_id, priority, status) VALUES ($1::uuid, 1, 'QUEUED') ON CONFLICT (order_id) DO NOTHING`, [a.resource_id]);
    } else {
      await transition({ orderId: a.resource_id, to: "REJECTED", actor: checker, actorKind: "admin", reason: reason ?? "payout rejected by checker" });
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
