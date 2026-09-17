// Paytm Payment Gateway pay-ins (JS Checkout APIs).
//
// Contract (developer.paytm.com):
//   hosts     staging https://securegw-stage.paytm.in, production https://securegw.paytm.in
//   signing   PaytmChecksum over the JSON of `body`, with the Merchant Key (mid.salt)
//   initiate  POST /theia/api/v1/initiateTransaction?mid=&orderId=
//             { body: { requestType: "Payment", mid, websiteName, orderId, callbackUrl,
//                       txnAmount: { value, currency }, userInfo: { custId } }, head: { signature } }
//             -> { body: { resultInfo: { resultStatus: "S" }, txnToken } }
//   hosted    browser POSTs mid, orderId, txnToken to /theia/api/v1/showPaymentPage?mid=&orderId=
//   intent    POST /theia/api/v1/processTransaction?mid=&orderId=
//             { head: { txnToken }, body: { requestType: "NATIVE", mid, orderId, paymentMode: "UPI_INTENT" } }
//             -> { body: { resultInfo, deepLinkInfo: { deepLink: "upi://pay?…" } } }
//   status    POST /v3/order/status { body: { mid, orderId }, head: { signature } }
//             -> { body: { resultInfo: { resultStatus: TXN_SUCCESS | TXN_FAILURE | PENDING, resultCode },
//                          txnId, bankTxnId, txnAmount, paymentMode } }
//   callback  form POST to callbackUrl with CHECKSUMHASH over the other fields (sorted, "|"-joined)
//
// Credentials: MID = mid.key, Merchant Key = mid.salt, Website = extra.website.

import type { GatewayMid } from "@/lib/gateway-creds";
import { paytmChecksum, paytmChecksumOk } from "@/lib/payout-providers/paytm";
import {
  intentQueryOf, paiseFrom, rupees, type PayinCall, type PayinConnector, type PayinState,
} from "@/lib/payin-providers/types";

const host = (env?: string) => (env === "PROD" ? "https://securegw.paytm.in" : "https://securegw-stage.paytm.in");
const REF_OK = /^[A-Za-z0-9@._-]{1,50}$/;

async function post(mid: GatewayMid, path: string, payload: unknown, timeoutMs = 15_000): Promise<PayinCall<{ httpStatus: number; body: any }>> {
  try {
    const res = await fetch(`${host(mid.env)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try { return { ok: true, data: { httpStatus: res.status, body: JSON.parse(text) } }; }
    catch { return { ok: false, error: `Paytm returned a non-JSON reply (HTTP ${res.status})` }; }
  } catch {
    return { ok: false, error: "Paytm unreachable" };
  }
}

/** A request with Paytm's signed envelope: the signature covers the exact JSON of `body`. */
function signed(mid: GatewayMid, body: Record<string, unknown>) {
  const json = JSON.stringify(body);
  return { json, envelope: `{"body":${json},"head":{"signature":${JSON.stringify(paytmChecksum(json, mid.salt))}}}` };
}

async function postSigned(mid: GatewayMid, path: string, body: Record<string, unknown>, timeoutMs?: number) {
  const { envelope } = signed(mid, body);
  try {
    const res = await fetch(`${host(mid.env)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: envelope,
      signal: AbortSignal.timeout(timeoutMs ?? 15_000),
    });
    const text = await res.text();
    try { return { ok: true as const, data: { httpStatus: res.status, body: JSON.parse(text) } }; }
    catch { return { ok: false as const, error: `Paytm returned a non-JSON reply (HTTP ${res.status})` }; }
  } catch {
    return { ok: false as const, error: "Paytm unreachable" };
  }
}

const msgOf = (b: any, status: number) => {
  const ri = b?.body?.resultInfo ?? {};
  return String([ri.resultCode, ri.resultMsg].filter(Boolean).join(" ") || `HTTP ${status}`).slice(0, 200);
};

async function initiate(mid: GatewayMid, o: { txnid: string; amountMinor: bigint; currency: string; phone: string; returnUrl: string }): Promise<PayinCall<string>> {
  if (!REF_OK.test(o.txnid)) return { ok: false, error: "Paytm needs a txnid of at most 50 letters, digits or @ . _ -" };
  const q = new URLSearchParams({ mid: mid.key, orderId: o.txnid });
  const r = await postSigned(mid, `/theia/api/v1/initiateTransaction?${q}`, {
    requestType: "Payment",
    mid: mid.key,
    websiteName: mid.extra?.website || (mid.env === "PROD" ? "DEFAULT" : "WEBSTAGING"),
    orderId: o.txnid,
    callbackUrl: o.returnUrl,
    txnAmount: { value: rupees(o.amountMinor), currency: o.currency },
    userInfo: { custId: `kt_${o.phone.replace(/\D/g, "").slice(-10) || "customer"}` },
  });
  if (!r.ok) return r;
  const { httpStatus, body } = r.data;
  if (body?.body?.resultInfo?.resultStatus === "S" && body?.body?.txnToken) return { ok: true, data: String(body.body.txnToken) };
  return { ok: false, error: `Paytm refused the order: ${msgOf(body, httpStatus)}` };
}

export const paytmPayin: PayinConnector = {
  id: "PAYTM",
  name: "Paytm",

  async checkout(mid, o) {
    const t = await initiate(mid, o);
    if (!t.ok) return t;
    const q = new URLSearchParams({ mid: mid.key, orderId: o.txnid });
    return {
      ok: true,
      data: { kind: "form", url: `${host(mid.env)}/theia/api/v1/showPaymentPage?${q}`, fields: { mid: mid.key, orderId: o.txnid, txnToken: t.data } },
    };
  },

  async upiIntent(mid, o) {
    const t = await initiate(mid, o);
    if (!t.ok) return t;
    const q = new URLSearchParams({ mid: mid.key, orderId: o.txnid });
    const r = await post(mid, `/theia/api/v1/processTransaction?${q}`, {
      head: { txnToken: t.data },
      body: { requestType: "NATIVE", mid: mid.key, orderId: o.txnid, paymentMode: "UPI_INTENT" },
    }, 20_000);
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    const intent = intentQueryOf(body?.body?.deepLinkInfo?.deepLink);
    if (!intent) return { ok: false, error: `Paytm did not return a UPI intent: ${msgOf(body, httpStatus)}` };
    return { ok: true, data: { intentQuery: intent, paymentId: body?.body?.deepLinkInfo?.cashierRequestId ?? null } };
  },

  async status(mid, txnid) {
    if (!REF_OK.test(txnid)) return { ok: true, data: { found: false } };
    const r = await postSigned(mid, "/v3/order/status", { mid: mid.key, orderId: txnid });
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    const b = body?.body ?? {};
    const ri = b.resultInfo ?? {};
    const st = String(ri.resultStatus ?? "").toUpperCase();
    const code = String(ri.resultCode ?? "");
    // 334/335: Paytm has no such order (never initiated, or the id is wrong).
    if (code === "334" || code === "335" || /invalid order|no record/i.test(String(ri.resultMsg ?? "")))
      return { ok: true, data: { found: false } };
    if (!st || code === "501") return { ok: false, error: `Paytm lookup failed: ${msgOf(body, httpStatus)}` };
    if (b.orderId && String(b.orderId) !== txnid) return { ok: false, error: `Paytm answered for ${b.orderId}` };
    const final: PayinState["final"] = st === "TXN_SUCCESS" ? "SUCCESS" : st === "TXN_FAILURE" ? "FAILED" : null;
    return {
      ok: true,
      data: {
        found: true, final, status: st,
        paymentId: b.txnId ? String(b.txnId) : undefined,
        bankRef: b.bankTxnId ? String(b.bankTxnId) : undefined,
        amountMinor: paiseFrom(b.txnAmount),
        mode: b.paymentMode ? String(b.paymentMode) : undefined,
        error: final === "FAILED" ? String(ri.resultMsg ?? "") || undefined : undefined,
        raw: b,
      },
    };
  },
};

/** Paytm's callback checksum: the other fields sorted by name, values joined with "|". */
export function paytmCallbackChecksumOk(mid: GatewayMid, fields: Record<string, string>): boolean | null {
  const sum = fields.CHECKSUMHASH;
  if (!sum) return null;
  const s = Object.keys(fields).filter((k) => k !== "CHECKSUMHASH").sort()
    .map((k) => (fields[k] != null && String(fields[k]).toLowerCase() !== "null" ? fields[k] : "")).join("|");
  return paytmChecksumOk(s, mid.salt, sum);
}

export function paytmCallbackTxnid(fields: Record<string, any>): string {
  return String(fields.ORDERID ?? fields.orderId ?? fields?.body?.orderId ?? "");
}
