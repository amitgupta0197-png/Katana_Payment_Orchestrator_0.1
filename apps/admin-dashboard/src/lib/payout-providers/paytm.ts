// Paytm Payouts (Paytm for Business disbursals) — money OUT from a sub-wallet of the
// merchant's own Paytm account.
//
// Contract (developer.paytm.com, Payouts):
//   hosts     staging https://staging-dashboard.paytm.com, production https://dashboard.paytm.com
//   auth      headers x-mid (MID) and x-checksum: the PaytmChecksum signature of the exact JSON
//             body string, made with the Merchant Key (see paytmChecksum below)
//   transfer  POST /bpay/api/v1/disburse/order/bank
//             body { subwalletGuid, orderId, beneficiaryAccount, beneficiaryIFSC | beneficiaryVPA,
//                    amount ("1.00"), purpose, date (yyyy-MM-dd), transferMode, comments, callbackUrl }
//             -> { status: ACCEPTED | SUCCESS | PENDING | FAILURE, statusCode, statusMessage, result }
//   status    POST /bpay/api/v1/disburse/order/query  body { orderId }
//             -> { status: SUCCESS | FAILURE | PENDING | CANCELLED, statusCode, statusMessage,
//                  result { orderId, paytmOrderId, amount, rrn, reversalReason, ... } }
//   callback  Paytm posts the same shape as the status query to callbackUrl (Katana's webhook).
//
// The callback is only a hint: the webhook route re-asks the status API before acting.

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "crypto";
import { getPayoutGateway } from "@/lib/payout-gateway";
import type { GatewayEnv } from "@/lib/pg-catalog";
import {
  istDay, paiseFrom, payoutWebhookUrlFor, rupees, type PayoutConnector, type ProviderCall, type TransferState,
} from "@/lib/payout-providers/types";

export interface PaytmPayoutCreds {
  env: GatewayEnv;
  mid: string;
  merchant_key: string;
  subwallet_guid: string;
}

const base = (env: GatewayEnv) => (env === "PROD" ? "https://dashboard.paytm.com" : "https://staging-dashboard.paytm.com");

async function creds(merchantCode: string): Promise<PaytmPayoutCreds | null> {
  const g = await getPayoutGateway(merchantCode);
  if (!g || g.gateway !== "PAYTM") return null;
  const { mid, merchant_key, subwallet_guid } = g.fields;
  if (!mid || !merchant_key || !subwallet_guid) return null;
  return { env: g.env, mid, merchant_key, subwallet_guid };
}

// ── PaytmChecksum ────────────────────────────────────────────────────────────
// Same algorithm as Paytm's PaytmChecksum library:
//   salt = 4 random base64 chars; hash = sha256hex(body + "|" + salt) + salt;
//   checksum = base64(AES-CBC(hash, key = Merchant Key, iv = "@@@@&&&&####$$$$"))
const IV = Buffer.from("@@@@&&&&####$$$$");
function cipherFor(key: string): string {
  const n = Buffer.byteLength(key);
  return n === 32 ? "aes-256-cbc" : n === 24 ? "aes-192-cbc" : "aes-128-cbc";
}

export function paytmChecksum(body: string, key: string, salt = randomBytes(3).toString("base64")): string {
  const hash = createHash("sha256").update(`${body}|${salt}`).digest("hex") + salt;
  const c = createCipheriv(cipherFor(key), Buffer.from(key), IV);
  return Buffer.concat([c.update(hash, "utf8"), c.final()]).toString("base64");
}

export function paytmChecksumOk(body: string, key: string, checksum: string | null): boolean {
  if (!checksum) return false;
  try {
    const d = createDecipheriv(cipherFor(key), Buffer.from(key), IV);
    const plain = Buffer.concat([d.update(Buffer.from(checksum, "base64")), d.final()]).toString("utf8");
    const salt = plain.slice(-4);
    const want = Buffer.from(paytmChecksum(body, key, salt));
    const got = Buffer.from(checksum);
    return want.length === got.length && timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

async function call(c: PaytmPayoutCreds, path: string, payload: Record<string, unknown>, timeoutMs = 15_000): Promise<ProviderCall<{ httpStatus: number; body: any }>> {
  const body = JSON.stringify(payload);
  try {
    const res = await fetch(`${base(c.env)}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json",
        "x-mid": c.mid, "x-checksum": paytmChecksum(body, c.merchant_key),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try { return { ok: true, data: { httpStatus: res.status, body: JSON.parse(text) } }; }
    catch { return { ok: false, definite: false, error: `http_${res.status}: non-JSON reply` }; }
  } catch {
    return { ok: false, definite: false, error: "unreachable" };
  }
}

const errText = (b: any, status: number) =>
  String([b?.statusCode, b?.statusMessage].filter(Boolean).join(" ") || `http_${status}`).slice(0, 200);

function toState(ref: string, b: any): TransferState {
  const status = String(b?.status ?? "").toUpperCase();
  const res = b?.result ?? {};
  const reversal = res.reversalReason ? String(res.reversalReason) : "";
  const final: TransferState["final"] =
    status === "SUCCESS" ? "SUCCESS"
    : status === "REVERSED" || status === "REVERSAL" ? "REVERSED"
    : status === "FAILURE" || status === "FAILED" || status === "CANCELLED" ? "FAILED"
    : null;
  return {
    found: true,
    ref,
    final,
    status: reversal && final === "FAILED" ? `${status} (${reversal})` : status,
    providerRef: res.paytmOrderId ? String(res.paytmOrderId) : undefined,
    bankRef: res.rrn ? String(res.rrn) : undefined,
    amountMinor: paiseFrom(res.amount),
    msg: reversal || (b?.statusMessage ? String(b.statusMessage) : undefined),
    raw: b,
  };
}

// Comments: plain text only.
const comments = (s: string) => s.replace(/[^A-Za-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 50) || "Payout";

export const paytmConnector: PayoutConnector<PaytmPayoutCreds> = {
  id: "PAYTM",
  name: "Paytm Payouts",
  rails: ["IMPS", "NEFT", "RTGS", "UPI"],
  creds,
  providerRefFor: (txnRef) => txnRef,
  txnRefFrom: (ref) => ref,

  async transfer(c, t) {
    const payload: Record<string, unknown> = {
      subwalletGuid: c.subwallet_guid,
      orderId: t.ref,
      amount: rupees(t.amountMinor),
      purpose: "OTHERS",
      date: istDay(new Date()),
      transferMode: t.rail,
      comments: comments(t.purpose),
      callbackUrl: payoutWebhookUrlFor("PAYTM"),
    };
    if (t.rail === "UPI") payload.beneficiaryVPA = t.vpa;
    else { payload.beneficiaryAccount = t.accountNumber; payload.beneficiaryIFSC = t.ifsc; }

    const r = await call(c, "/bpay/api/v1/disburse/order/bank", payload);
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    const status = String(body?.status ?? "").toUpperCase();
    if (status === "ACCEPTED" || status === "PENDING" || status === "SUCCESS") {
      return { ok: true, data: { state: status === "SUCCESS" ? toState(t.ref, body) : undefined } };
    }
    if (status === "FAILURE") {
      // A duplicate orderId means Paytm already has this payout: not a refusal of it.
      if (/duplicate|already/i.test(String(body?.statusMessage ?? "")))
        return { ok: false, definite: false, error: errText(body, httpStatus) };
      return { ok: false, definite: true, error: errText(body, httpStatus) };
    }
    return { ok: false, definite: false, error: errText(body, httpStatus) };
  },

  async status(c, ref, opts) {
    const r = await call(c, "/bpay/api/v1/disburse/order/query", { orderId: ref }, opts.timeoutMs);
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    const status = String(body?.status ?? "").toUpperCase();
    if (!status) return { ok: false, definite: false, error: `lookup: ${errText(body, httpStatus)}` };
    if (status === "FAILURE" && /not\s*found|does not exist|invalid order/i.test(String(body?.statusMessage ?? "")))
      return { ok: true, data: { found: false } };
    const echoed = body?.result?.orderId;
    if (echoed && String(echoed) !== ref)
      return { ok: false, definite: false, error: `lookup: Paytm answered for ${echoed}` };
    return { ok: true, data: toState(ref, body) };
  },
};

/** The orderId a Paytm payout callback is about. */
export function paytmWebhookRef(body: Record<string, any>): { ref: string; event: string } {
  const ref = body?.result?.orderId ?? body?.orderId ?? "";
  return { ref: String(ref), event: String(body?.status ?? "").toUpperCase() };
}
