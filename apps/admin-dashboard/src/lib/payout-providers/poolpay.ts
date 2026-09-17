// PoolPay Payouts (Merchant Initiated Payout, doc v1.7) — money OUT from the merchant's
// PoolPay payout wallet.
//
// Contract (PoolPay Withdrawal API Integration Document v1.7):
//   host      https://payout.pp-007.com (production; PoolPay whitelists the caller's IP)
//   hash      base64 HMAC-SHA256(data, salt)
//   initiate  POST /payout/api/gateway/v1/initiate
//             { transfer_mode (IMPS | RTGS | UPI), beneficiary_name, beneficiary_mobile_number,
//               beneficiary_account_number, beneficiary_ifsc | beneficiary_vpa, purpose, amount
//               (rupees, ≤2 decimals), pay_id (number), order_id, remarks (RTGS only), hash }
//             hash data, "~"-joined in this order:
//               bank: beneficiary_name, beneficiary_mobile_number, beneficiary_account_number,
//                     beneficiary_ifsc, purpose, amount, pay_id, order_id[, remarks (RTGS)]
//               UPI:  beneficiary_name, beneficiary_mobile_number, beneficiary_vpa, purpose,
//                     amount, pay_id, order_id
//             -> { status: "Success", transaction_id, transaction_status, acquirer_transaction_id, ... }
//             -> { status: "Failed", message: "Hash Validation Failed" | "Duplicate order Id" |
//                  "InSufficient Balance" | ... }
//   enquiry   POST /payout/api/gateway/v1/enquiry?order_id=<id>&hash=<urlencoded hash("order_id=<id>")>
//   balance   POST /payout/api/gateway/v1/getMerchantBalance { pay_id, hash("pay_id=<id>") } -> { balance }
//   callback  POSTed to the URL set in PoolPay's merchant portal; same shape as the enquiry reply.
//
// transaction_status: Created, Processing -> in flight; Completed -> paid; Failed -> not paid;
// BouncedBack -> returned by the beneficiary's bank.
//
// Purpose codes are fixed by amount (doc annexure). NEFT is not offered.

import { createHmac } from "crypto";
import { getPayoutGateway } from "@/lib/payout-gateway";
import type { GatewayEnv } from "@/lib/pg-catalog";
import { paiseFrom, rupees, type PayoutConnector, type ProviderCall, type TransferState } from "@/lib/payout-providers/types";

export interface PoolpayPayoutCreds {
  env: GatewayEnv;
  pay_id: string;
  salt: string;
  api_base: string;
  /** Mobile number sent for beneficiaries that have none on file (PoolPay requires one). */
  default_mobile: string;
}

const DEFAULT_BASE = "https://payout.pp-007.com";

export function poolpayHash(data: string, salt: string): string {
  return createHmac("sha256", salt).update(data).digest("base64");
}

async function creds(merchantCode: string): Promise<PoolpayPayoutCreds | null> {
  const g = await getPayoutGateway(merchantCode);
  if (!g || g.gateway !== "POOLPAY") return null;
  const { pay_id, salt, api_base, default_mobile } = g.fields;
  if (!pay_id || !salt) return null;
  return {
    env: g.env, pay_id, salt,
    // PoolPay publishes only a production host. A TEST account must name its UAT host, so a
    // sandbox payout can never reach production by default.
    api_base: (api_base || (g.env === "PROD" ? DEFAULT_BASE : "")).replace(/\/$/, ""),
    default_mobile: default_mobile || "9999999999",
  };
}

/** Rupees the way PoolPay wants them: 100, 100.5, 100.15. */
export function poolpayAmount(minor: bigint): string {
  return String(Number(rupees(minor)));
}

/** Purpose code by amount (paise), per the doc's annexure. */
export function poolpayPurpose(minor: bigint): string {
  if (minor <= 300_000n) return "Cashbacks";
  if (minor <= 500_000n) return "LoyaltyPointsRedemption";
  if (minor <= 1_000_000n) return "Refunds";
  if (minor <= 3_000_000n) return "MarketingCampaign";
  return "VendorPayouts";
}

// pay_id is a 16-digit number. Keep its digits exactly as given rather than trusting a JS number.
function jsonWithPayId(obj: Record<string, unknown>, payId: string): string {
  if (!/^\d{1,19}$/.test(payId)) throw new Error("pay_id must be digits");
  return JSON.stringify({ ...obj, pay_id: "__PAY_ID__" }).replace('"__PAY_ID__"', payId);
}

async function post(c: PoolpayPayoutCreds, path: string, body: string | undefined, timeoutMs = 15_000): Promise<ProviderCall<{ httpStatus: number; body: any }>> {
  if (!c.api_base) return { ok: false, definite: true, error: "no PoolPay UAT URL is set for this merchant's TEST account" };
  try {
    const res = await fetch(`${c.api_base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
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

function finalOf(s: string): TransferState["final"] {
  const v = s.toLowerCase();
  if (v === "completed") return "SUCCESS";
  if (v === "failed") return "FAILED";
  if (v === "bouncedback") return "REVERSED";
  return null;
}

export function poolpayState(b: any): TransferState & { ref: string } {
  const status = String(b?.transaction_status ?? "");
  const code = b?.acquirer_status_code;
  const msg = String(b?.acquirer_status_message ?? "").trim();
  return {
    found: true,
    ref: String(b?.order_id ?? ""),
    final: finalOf(status),
    status: status.toUpperCase(),
    providerRef: b?.transaction_id ? String(b.transaction_id) : undefined,
    // PoolPay's acquirer_transaction_id is the bank-side reference it reports.
    bankRef: b?.acquirer_transaction_id ? String(b.acquirer_transaction_id) : undefined,
    amountMinor: paiseFrom(b?.amount),
    msg: msg ? (code != null && code !== "0" ? `${msg} (code ${code})` : msg) : undefined,
    raw: b,
  };
}

const REF_OK = /^[A-Za-z0-9_\-]{1,40}$/;

export const poolpayConnector: PayoutConnector<PoolpayPayoutCreds> = {
  id: "POOLPAY",
  name: "PoolPay",
  rails: ["IMPS", "RTGS", "UPI"],
  creds,
  providerRefFor: (txnRef) => txnRef,
  txnRefFrom: (ref) => ref,

  async transfer(c, t) {
    if (!REF_OK.test(t.ref)) return { ok: false, definite: true, error: "order id has characters PoolPay may not accept" };
    const amount = poolpayAmount(t.amountMinor);
    const purpose = poolpayPurpose(t.amountMinor);
    const name = t.beneficiaryName.trim();
    const mobile = c.default_mobile;
    const remarks = t.rail === "RTGS" ? (t.purpose.replace(/[^A-Za-z0-9]/g, "").slice(0, 30) || "Payout") : undefined;

    const hashParts = t.rail === "UPI"
      ? [["beneficiary_name", name], ["beneficiary_mobile_number", mobile], ["beneficiary_vpa", t.vpa ?? ""],
         ["purpose", purpose], ["amount", amount], ["pay_id", c.pay_id], ["order_id", t.ref]]
      : [["beneficiary_name", name], ["beneficiary_mobile_number", mobile], ["beneficiary_account_number", t.accountNumber ?? ""],
         ["beneficiary_ifsc", t.ifsc ?? ""], ["purpose", purpose], ["amount", amount], ["pay_id", c.pay_id], ["order_id", t.ref],
         ...(remarks ? [["remarks", remarks]] : [])];
    const hash = poolpayHash(hashParts.map(([k, v]) => `${k}=${v}`).join("~"), c.salt);

    const body: Record<string, unknown> = {
      transfer_mode: t.rail,
      beneficiary_name: name,
      beneficiary_mobile_number: mobile,
      purpose,
      amount: Number(amount),
      order_id: t.ref,
      hash,
    };
    if (t.rail === "UPI") body.beneficiary_vpa = t.vpa;
    else { body.beneficiary_account_number = t.accountNumber; body.beneficiary_ifsc = t.ifsc; }
    if (remarks) body.remarks = remarks;

    let json: string;
    try { json = jsonWithPayId(body, c.pay_id); } catch (e) { return { ok: false, definite: true, error: (e as Error).message }; }
    const r = await post(c, "/payout/api/gateway/v1/initiate", json);
    if (!r.ok) return r;
    const { httpStatus, body: j } = r.data;
    const status = String(j?.status ?? "");
    if (status === "Success") {
      const state = poolpayState(j);
      return { ok: true, data: { providerRef: state.providerRef, state } };
    }
    const message = String(j?.message ?? `http_${httpStatus}`).slice(0, 200);
    // A duplicate order id means PoolPay already has this payout; the enquiry says how it went.
    if (status === "Failed" && !/duplicate/i.test(message)) return { ok: false, definite: true, error: message };
    return { ok: false, definite: false, error: message };
  },

  async status(c, ref, opts) {
    const hash = poolpayHash(`order_id=${ref}`, c.salt);
    const q = `order_id=${encodeURIComponent(ref)}&hash=${encodeURIComponent(hash)}`;
    const r = await post(c, `/payout/api/gateway/v1/enquiry?${q}`, undefined, opts.timeoutMs);
    if (!r.ok) return r;
    const { httpStatus, body: j } = r.data;
    if (String(j?.status) === "Success" && j?.transaction_status) {
      if (j.order_id != null && String(j.order_id) !== ref)
        return { ok: false, definite: false, error: `lookup: PoolPay answered for ${j.order_id}` };
      return { ok: true, data: poolpayState(j) };
    }
    const message = String(j?.message ?? j?.error ?? `http_${httpStatus}`);
    if (/not\s*found|no\s*record|invalid\s*order|does\s*not\s*exist/i.test(message)) return { ok: true, data: { found: false } };
    return { ok: false, definite: false, error: `lookup: ${message.slice(0, 160)}` };
  },

  async balance(c) {
    let json: string;
    try { json = jsonWithPayId({ hash: poolpayHash(`pay_id=${c.pay_id}`, c.salt) }, c.pay_id); }
    catch (e) { return { ok: false, definite: true, error: (e as Error).message }; }
    const r = await post(c, "/payout/api/gateway/v1/getMerchantBalance", json, 8_000);
    if (!r.ok) return r;
    const { httpStatus, body: j } = r.data;
    const bal = paiseFrom(j?.balance);
    if (String(j?.status) !== "Success" || bal == null)
      return { ok: false, definite: false, error: `balance: ${String(j?.message ?? "http_" + httpStatus).slice(0, 160)}` };
    return { ok: true, data: { balanceMinor: bal, lowBalance: false } };
  },
};

/** The order a PoolPay callback is about. */
export function poolpayCallbackRef(body: any): { ref: string; event: string } {
  return { ref: String(body?.order_id ?? ""), event: String(body?.transaction_status ?? "").toUpperCase() };
}
