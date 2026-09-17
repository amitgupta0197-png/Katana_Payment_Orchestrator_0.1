// Per-merchant payout policy: amount limits, allowed rails and the approval rule, plus the
// merchant suspension switch. Checked whenever a payout is created, from the dashboard or
// the API, and again before a held payout is sent.

import { rows } from "@/lib/pg";
import type { PayoutRail } from "@/lib/payout-providers/types";

export type ApprovalRule = "AUTO" | "MAKER_CHECKER";
export const PAYOUT_RAILS: PayoutRail[] = ["IMPS", "NEFT", "RTGS", "UPI"];

export interface PayoutPolicy {
  merchant_id: string;
  min_txn_minor: bigint | null;
  max_txn_minor: bigint | null;
  daily_minor: bigint | null;
  allowed_rails: PayoutRail[] | null;
  approval_rule: ApprovalRule;
  updated_by: string | null;
  updated_at: string | null;
}

const big = (v: string | null) => (v == null ? null : BigInt(v));

export async function getPayoutPolicy(merchantId: string): Promise<PayoutPolicy> {
  const r = (await rows<any>("fifo", `
    SELECT merchant_id, min_txn_minor::text, max_txn_minor::text, daily_minor::text, allowed_rails,
           approval_rule, updated_by, updated_at
      FROM fifo_payout_policies WHERE merchant_id=$1
  `, [merchantId]))[0];
  if (!r) return { merchant_id: merchantId, min_txn_minor: null, max_txn_minor: null, daily_minor: null, allowed_rails: null, approval_rule: "AUTO", updated_by: null, updated_at: null };
  return {
    ...r, min_txn_minor: big(r.min_txn_minor), max_txn_minor: big(r.max_txn_minor), daily_minor: big(r.daily_minor),
    allowed_rails: r.allowed_rails?.length ? r.allowed_rails : null,
  };
}

export async function savePayoutPolicy(p: Omit<PayoutPolicy, "updated_at">): Promise<void> {
  await rows("fifo", `
    INSERT INTO fifo_payout_policies (merchant_id, min_txn_minor, max_txn_minor, daily_minor, allowed_rails, approval_rule, updated_by, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,now())
    ON CONFLICT (merchant_id) DO UPDATE SET
      min_txn_minor=EXCLUDED.min_txn_minor, max_txn_minor=EXCLUDED.max_txn_minor, daily_minor=EXCLUDED.daily_minor,
      allowed_rails=EXCLUDED.allowed_rails, approval_rule=EXCLUDED.approval_rule,
      updated_by=EXCLUDED.updated_by, updated_at=now()
  `, [p.merchant_id, p.min_txn_minor?.toString() ?? null, p.max_txn_minor?.toString() ?? null, p.daily_minor?.toString() ?? null,
      p.allowed_rails?.length ? p.allowed_rails : null, p.approval_rule, p.updated_by]);
}

/** The Suspend switch on the merchant page (merchant_payment_config.blocked) stops payouts too. */
export async function isMerchantSuspended(merchantId: string): Promise<boolean> {
  const r = await rows<{ blocked: boolean }>("merchant",
    `SELECT COALESCE(blocked,false) AS blocked FROM merchant_payment_config WHERE merchant_code=$1`, [merchantId]);
  return r[0]?.blocked === true;
}

const inr = (m: bigint) => `₹${(Number(m) / 100).toLocaleString("en-IN")}`;

/** Why this payout breaks the merchant's policy, or null. `rail` is only known for provider payouts. */
export async function checkPayoutPolicy(p: PayoutPolicy, amountMinor: bigint, rail: PayoutRail | undefined, livemode: boolean): Promise<string | null> {
  if (p.min_txn_minor != null && amountMinor < p.min_txn_minor) return `payout is below this merchant's minimum of ${inr(p.min_txn_minor)}`;
  if (p.max_txn_minor != null && amountMinor > p.max_txn_minor) return `payout is above this merchant's maximum of ${inr(p.max_txn_minor)}`;
  if (rail && p.allowed_rails && !p.allowed_rails.includes(rail)) return `${rail} is not allowed for this merchant (allowed: ${p.allowed_rails.join(", ")})`;
  if (p.daily_minor != null) {
    // Today in India. Refused payouts don't count; ones still waiting for approval do.
    const used = BigInt((await rows<{ s: string }>("fifo", `
      SELECT COALESCE(SUM(amount_minor),0)::text AS s FROM fifo_orders
       WHERE merchant_id=$1 AND direction='PAYOUT' AND livemode=$2
         AND status NOT IN ('REJECTED','CANCELLED','FAILED')
         AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
    `, [p.merchant_id, livemode]))[0]?.s ?? "0");
    if (used + amountMinor > p.daily_minor)
      return `would exceed this merchant's daily payout limit of ${inr(p.daily_minor)} (${inr(used)} used today)`;
  }
  return null;
}
