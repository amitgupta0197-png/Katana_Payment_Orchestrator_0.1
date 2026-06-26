// Universal transaction representation — one canonical shape across every
// channel (checkout_orders for PayU/Cashfree/Razorpay; vendor_payin_orders for
// PoolPay/Quickpay). This is the §4 "Universal Response":
//   { katana_order_id, provider, provider_txn_id, status, utr, amount,
//     merchant_id, sub_mid }  (+ method, currency, created_at, source for UI)

export interface UniversalTxn {
  katana_order_id: string;
  source: "CHECKOUT" | "PAYIN";
  provider: string;
  provider_txn_id: string;
  status: string;      // canonical status (see normalizeStatus)
  utr: string | null;
  amount: number;
  currency: string;
  method: string;
  merchant_id: string;
  sub_mid: string | null;
  created_at: string;
}

// Canonical status set per the plan's lifecycle:
//   INITIATED → PENDING → AWAITING_CONFIRMATION → SUCCESS|FAILED|EXPIRED|MISMATCH|MANUAL_REVIEW
const STATUS_MAP: Record<string, string> = {
  SUCCEEDED: "SUCCESS", SUCCESS: "SUCCESS",
  FAILED: "FAILED", DECLINED: "FAILED",
  EXPIRED: "EXPIRED",
  PENDING: "PENDING", PROCESSING: "PENDING",
  INITIATED: "INITIATED", CREATED: "INITIATED",
  AWAITING_CONFIRMATION: "AWAITING_CONFIRMATION",
  MISMATCH: "MISMATCH",
  MANUAL_REVIEW: "MANUAL_REVIEW", UNDER_REVIEW: "MANUAL_REVIEW", HELD: "MANUAL_REVIEW",
};

export function normalizeStatus(s: string | null | undefined): string {
  if (!s) return "INITIATED";
  return STATUS_MAP[s.toUpperCase()] ?? s.toUpperCase();
}

export const CANONICAL_STATUSES = [
  "INITIATED", "PENDING", "AWAITING_CONFIRMATION",
  "SUCCESS", "FAILED", "EXPIRED", "MISMATCH", "MANUAL_REVIEW",
] as const;

export function checkoutToUniversal(r: any): UniversalTxn {
  return {
    katana_order_id: r.id,
    source: "CHECKOUT",
    provider: r.selected_rail || "DIRECT",
    provider_txn_id: r.provider_txn_id || r.txn_id || "",
    status: normalizeStatus(r.status),
    utr: r.utr || null,
    amount: Number(r.amount) || 0,
    currency: r.currency || "INR",
    method: r.method || "",
    merchant_id: r.merchant_id || "",
    sub_mid: null,
    created_at: r.created_at,
  };
}

export function payinToUniversal(r: any): UniversalTxn {
  return {
    katana_order_id: r.id,
    source: "PAYIN",
    provider: r.vendor || "",
    provider_txn_id: r.vendor_txn_id || "",
    status: normalizeStatus(r.status),
    utr: r.rrn || null,
    amount: Number(r.amount) || 0,
    currency: r.currency_code || "INR",
    method: r.channel || "",
    merchant_id: r.merchant_id || "",
    sub_mid: r.sub_mid_code || null,
    created_at: r.created_at,
  };
}
