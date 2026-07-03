// PoolPay S2S pay-in — sandbox dispatcher.
//
// Flow modelled: order create -> deeplink response (Paytm / PhonePe / generic UPI
// + QR) -> customer pays -> status enquiry / callback -> final status.
//
// This is the SANDBOX implementation: createPoolPayOrder() synthesises a
// deterministic deeplink response and enquirePoolPayStatus() advances the order
// over time so the end-to-end flow is demoable without live PoolPay credentials.
// For the real integration, replace the bodies with signed HTTP calls to
// PoolPay's S2S /order/create and /order/status endpoints and parse their
// deeplink payload — the shapes below already match that contract.

import { signPoolPay } from "@/lib/provider-integration";

const PAYEE_VPA = "poolpay.sandbox@upi"; // gateway collect VPA (payee)
const PAYEE_NAME = "Katana Pay";

export interface DeepLinks {
  paytm: string;
  phonepe: string;
  upi: string; // generic UPI intent (also used as the QR payload)
}

// Build the UPI parameter string shared by every app deeplink and the QR.
export function buildUpiQuery(opts: { payeeVpa?: string; orderId: string; amount: number; note?: string }): string {
  const params = new URLSearchParams({
    pa: opts.payeeVpa ?? PAYEE_VPA,
    pn: PAYEE_NAME,
    tr: opts.orderId,
    am: opts.amount.toFixed(2),
    cu: "INR",
    tn: opts.note ?? `Order ${opts.orderId}`,
  });
  return params.toString();
}

export function buildDeeplinks(query: string): DeepLinks {
  return {
    paytm: `paytmmp://pay?${query}`,
    phonepe: `phonepe://pay?${query}`,
    upi: `upi://pay?${query}`,
  };
}

// Sandbox status decision. An S2S order does NOT settle on its own — like the real
// flow, it stays PENDING until the payer pays and a webhook/UTR confirms it (the
// /confirm endpoint or the vendor callback). Only the pending-expiry rule and the
// amount-forced test outcomes change status automatically:
//   ...13  -> FAILED  (customer declined / U30)
//   ...11  -> EXPIRED (collect request lapsed / U69)
//   ...99  -> SUCCESS (forced success, ~8s — for testing the happy path)
//   else   -> PENDING (awaits confirmation / webhook / pending-expiry)
//
// CRITICAL: these amount-based outcomes are TEST hooks only. On real merchant
// traffic they would auto-FAIL / auto-EXPIRE / auto-SUCCEED any order whose amount
// happens to end in .13 / .11 / .99 paise — with NO payment ever made. They are
// therefore gated behind POOLPAY_SANDBOX_OUTCOMES=1 and are OFF by default (and in
// production). With them off, an order stays PENDING until a REAL confirmation
// (agent bank-credit alert, vendor webhook, or manual ops) or the pending-expiry
// timeout — it never changes state on its own.
function sandboxOutcomesEnabled(): boolean {
  return process.env.POOLPAY_SANDBOX_OUTCOMES === "1";
}
export function decidePoolPayStatus(
  amountMinor: number,
  ageSeconds: number,
): { status: "PENDING" | "SUCCESS" | "FAILED" | "EXPIRED"; response_code: string } {
  if (sandboxOutcomesEnabled()) {
    if (amountMinor % 100 === 13) return { status: "FAILED", response_code: "U30" };
    if (amountMinor % 100 === 11) return { status: "EXPIRED", response_code: "U69" };
    if (amountMinor % 100 === 99 && ageSeconds >= 8) return { status: "SUCCESS", response_code: "00" }; // forced test success
  }
  return { status: "PENDING", response_code: "U17" }; // default: awaits real confirmation
}

export const POOLPAY_TERMINAL = new Set(["SUCCESS", "SUCCEEDED", "FAILED", "EXPIRED"]);

// Auto-resolution pause. The status enquiry / poller normally advances a PENDING
// order over time (sandbox amount rule + pending-expiry). It must NOT do so while
// the order is parked for a human decision: a high-amount hold (meta.hold) or a
// sender payment proof awaiting ops verification (meta.review === 'PROOF_SUBMITTED').
// Pausing here stops a proof-bearing order from silently expiring before review.
export function autoResolvePaused(meta: { hold?: boolean; review?: string } | null | undefined): boolean {
  return meta?.hold === true || meta?.review === "PROOF_SUBMITTED";
}

// Stable 12-digit RRN derived from the order id (so repeated enquiries match).
export function genRrn(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 1_000_000_000_000;
  return h.toString().padStart(12, "0");
}

// Status-intelligence rules ------------------------------------------------
// Pending-expiry: a pay-in still PENDING past this age is force-EXPIRED so it
// never hangs forever (sandbox 15 min; tune per provider SLA when live).
export const PENDING_EXPIRY_SECONDS = 900;

// Single source of truth for resolving a PoolPay order's status. Enforces the
// final-status lock (terminal never re-resolves), then the deterministic sandbox
// decision, then the pending-expiry rule. Used by the status enquiry, the cron
// sweep poller, and the force-refresh action so they can never disagree.
export function resolvePoolPay(
  currentStatus: string,
  amountMinor: number,
  ageSeconds: number,
): { status: string; response_code: string; changed: boolean } {
  if (POOLPAY_TERMINAL.has(currentStatus)) {
    return { status: currentStatus, response_code: "", changed: false }; // final-status lock
  }
  const d = decidePoolPayStatus(amountMinor, ageSeconds);
  let status = d.status, code = d.response_code;
  if (status === "PENDING" && ageSeconds >= PENDING_EXPIRY_SECONDS) {
    status = "EXPIRED"; code = "U69"; // pending-expiry
  }
  return { status, response_code: code, changed: status !== currentStatus };
}

// ---------------------------------------------------------------------------
// REAL PoolPay S2S integration point (scaffold).
//
// To go live, set in the server env (.env.local on the VPS):
//   POOLPAY_MODE=live
//   POOLPAY_BASE_URL=<from PoolPay>
//   POOLPAY_CLIENT_ID=<from PoolPay>
//   POOLPAY_API_KEY=<from PoolPay>          (and/or POOLPAY_SECRET for signing)
// Then replace the request paths / headers / response field mapping marked
// TODO(poolpay) below to match PoolPay's actual S2S API docs. Until POOLPAY_MODE
// is "live", everything runs in the deterministic sandbox above and these
// functions are never called.
// ---------------------------------------------------------------------------

export function poolpayLive(): boolean {
  return process.env.POOLPAY_MODE === "live" && !!process.env.POOLPAY_BASE_URL;
}

// Per-call config override resolved from the provider's integration row (cascade).
// When present it takes precedence over the POOLPAY_* env vars so each branch
// signs/routes with ITS provider's credentials. See resolvePoolPayConfig().
export interface RemoteOverride {
  baseUrl?: string | null;
  secret?: string | null;   // SECRET_KEY for the SHA256 hash
  payId?: string | null;
  clientId?: string | null;
  apiKey?: string | null;
  returnUrl?: string | null;
}

function poolpayHeaders(ov?: RemoteOverride): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-client-id": ov?.clientId ?? process.env.POOLPAY_CLIENT_ID ?? "",
    authorization: `Bearer ${ov?.apiKey ?? process.env.POOLPAY_API_KEY ?? ""}`,
  };
}

export interface RemoteOrderInput {
  orderId: string; amount: number; currency: string;
  customerVpa?: string; customerPhone?: string; note?: string;
  customerName?: string; customerEmail?: string; userId?: string;
}
export interface RemoteOrderResult {
  payId: string; vendorTxnId: string; deeplinks: DeepLinks; upiIntent: string; status: string;
}

export async function createOrderRemote(input: RemoteOrderInput, ov?: RemoteOverride): Promise<RemoteOrderResult> {
  const base = (ov?.baseUrl ?? process.env.POOLPAY_BASE_URL)!;

  // When a SECRET_KEY + PAY_ID are configured we follow the documented PoolPay
  // AUTO payment-request contract: POST /api/v1/payin/paymentrequest with a
  // SHA256-signed HASH over the sorted params. Otherwise fall back to the generic
  // S2S scaffold shape.
  if (ov?.secret && ov?.payId) {
    const params: Record<string, string> = {
      PAY_ID: ov.payId,
      ORDER_ID: input.orderId,
      TXNTYPE: "SALE",
      RETURN_URL: ov.returnUrl ?? process.env.POOLPAY_RETURN_URL ?? "",
      CUST_NAME: input.customerName ?? "Customer",
      USER_ID: input.userId ?? input.orderId,
      CUST_PHONE: input.customerPhone ?? "",
      CUST_EMAIL: input.customerEmail ?? "",
      AMOUNT: String(input.amount),
      CURRENCY_CODE: input.currency === "INR" ? "356" : input.currency,
      ORDER_DESC: input.note ?? `Order ${input.orderId}`,
    };
    const HASH = signPoolPay(params, ov.secret);
    const res = await fetch(`${base}/api/v1/payin/paymentrequest`, {
      method: "POST",
      headers: poolpayHeaders(ov),
      body: JSON.stringify({ ...params, HASH }),
    });
    if (!res.ok) throw new Error(`PoolPay payment-request failed: HTTP ${res.status}`);
    const d: any = await res.json();
    const upi = d?.deeplinks?.upi ?? d?.intent_url ?? d?.pay_url ?? "";
    return {
      payId: d?.PAY_ID ?? d?.pay_id ?? ov.payId,
      vendorTxnId: d?.TXN_ID ?? d?.txn_id ?? "",
      deeplinks: { paytm: d?.deeplinks?.paytm ?? upi, phonepe: d?.deeplinks?.phonepe ?? upi, upi },
      upiIntent: upi,
      status: d?.STATUS ?? d?.status ?? "PENDING",
    };
  }

  // TODO(poolpay): align path/body with PoolPay's real S2S order-create contract.
  const res = await fetch(`${base}/v1/order/create`, {
    method: "POST",
    headers: poolpayHeaders(ov),
    body: JSON.stringify({
      order_id: input.orderId, amount: input.amount, currency: input.currency,
      customer_vpa: input.customerVpa, customer_phone: input.customerPhone, note: input.note,
    }),
  });
  if (!res.ok) throw new Error(`PoolPay order-create failed: HTTP ${res.status}`);
  const data: any = await res.json();
  // TODO(poolpay): map PoolPay's deeplink response fields to these.
  const upi = data?.deeplinks?.upi ?? data?.intent_url ?? "";
  return {
    payId: data?.pay_id ?? data?.payId ?? "",
    vendorTxnId: data?.txn_id ?? data?.vendorTxnId ?? "",
    deeplinks: {
      paytm: data?.deeplinks?.paytm ?? upi,
      phonepe: data?.deeplinks?.phonepe ?? upi,
      upi,
    },
    upiIntent: upi,
    status: data?.status ?? "PENDING",
  };
}

export async function enquireStatusRemote(vendorTxnId: string): Promise<{ status: string; rrn?: string; response_code?: string }> {
  const base = process.env.POOLPAY_BASE_URL!;
  // TODO(poolpay): align with PoolPay's real status-enquiry contract.
  const res = await fetch(`${base}/v1/order/status?txn_id=${encodeURIComponent(vendorTxnId)}`, {
    headers: poolpayHeaders(),
  });
  if (!res.ok) throw new Error(`PoolPay status failed: HTTP ${res.status}`);
  const data: any = await res.json();
  return { status: data?.status, rrn: data?.rrn, response_code: data?.response_code };
}
