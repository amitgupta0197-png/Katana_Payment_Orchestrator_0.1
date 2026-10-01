// PoolPay — an UPSTREAM GATEWAY Katana can route a live pay-in through (internal; never named to
// a merchant, lib/merchant-safe). This is its server-to-server client. Katana's own order core
// is lib/katana-pay; this file is only reached when the upstream integration is live
// (POOLPAY_MODE=live, or a provider integration configured PROD with a secret).

import { signKatanaHash, type DeepLinks } from "@/lib/katana-pay";

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
    const HASH = signKatanaHash(params, ov.secret);
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
