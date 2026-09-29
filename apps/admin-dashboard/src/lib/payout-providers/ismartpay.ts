// iSmartPay Payouts — money OUT from the merchant's iSmartPay payout wallet.
//
// Contract (docs.ismartpay.co.in/in/payout):
//   auth      headers `mid` and `key`; iSmartPay whitelists the caller's IP
//   create    POST /api/create/payout
//             { amount (number, rupees), currency, purpose, order_id, narration, phone_number,
//               payment_details: { type: "NB", account_number, ifsc_code, beneficiary_name,
//                                  mode: IMPS | NEFT | RTGS } }
//             -> { status: true, status_code: "CREATED" | "FAIL" | …, message, transaction_id, ... }
//             -> { status: false, status_code: INVALID | DUPLICATE | UNAUTHORIZED | NON_WHITELISTED_IP, errors }
//   status    GET /api/payout/status/{transaction_id}   (iSmartPay's id, not Katana's order_id)
//             -> { status: true, status_code: "Success" | "PENDING" | "FAIL", message, bank_id (UTR), order_id, amount }
//   balance   GET /api/payout/wallet/details -> { status: true, balance }
//   callback  POSTed to the URL iSmartPay support sets up (not per transfer); same shape as status.
//
// status_code (any case): CREATED, PENDING -> in flight; SUCCESS -> paid; FAIL -> not paid.
// The doc shows bank transfers only (type NB), so UPI is not offered.

import { getPayoutGateway } from "@/lib/payout-gateway";
import type { GatewayEnv } from "@/lib/pg-catalog";
import { paiseFrom, rupees, type PayoutConnector, type ProviderCall, type TransferState } from "@/lib/payout-providers/types";

export interface IsmartpayPayoutCreds {
  env: GatewayEnv;
  mid: string;
  api_key: string;
  api_base: string;
  /** Phone number sent with payouts (iSmartPay asks for one; beneficiaries may have none). */
  default_mobile: string;
}

const DEFAULT_BASE = "https://pay.ismartpay.co.in";

async function creds(merchantCode: string): Promise<IsmartpayPayoutCreds | null> {
  const g = await getPayoutGateway(merchantCode);
  if (!g || g.gateway !== "ISMARTPAY") return null;
  const { mid, api_key, api_base, default_mobile } = g.fields;
  if (!mid || !api_key) return null;
  return {
    env: g.env, mid, api_key,
    // iSmartPay publishes only a production host. A TEST account must name its test host, so a
    // sandbox payout can never reach production by default.
    api_base: (api_base || (g.env === "PROD" ? DEFAULT_BASE : "")).replace(/\/$/, ""),
    default_mobile: default_mobile || "9999999999",
  };
}

async function call(c: IsmartpayPayoutCreds, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 15_000): Promise<ProviderCall<{ httpStatus: number; body: any }>> {
  if (!c.api_base) return { ok: false, definite: true, error: "no iSmartPay test URL is set for this merchant's TEST account" };
  try {
    const res = await fetch(`${c.api_base}${path}`, {
      method,
      headers: { mid: c.mid, key: c.api_key, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
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
  const v = s.toUpperCase();
  if (v === "SUCCESS") return "SUCCESS";
  if (v === "FAIL" || v === "FAILED") return "FAILED";
  return null;
}

export function ismartpayState(b: any): TransferState & { ref: string } {
  const status = String(b?.status_code ?? "");
  const msg = String(b?.message ?? "").trim();
  return {
    found: true,
    ref: String(b?.order_id ?? ""),
    final: finalOf(status),
    status: status.toUpperCase(),
    providerRef: b?.transaction_id ? String(b.transaction_id) : undefined,
    bankRef: b?.bank_id ? String(b.bank_id) : undefined,
    amountMinor: paiseFrom(b?.amount),
    msg: msg || undefined,
    raw: b,
  };
}

const REF_OK = /^[A-Za-z0-9_-]{1,40}$/;
// Codes on which iSmartPay has certainly not taken the payout.
const REFUSED = /^(INVALID|UNAUTHORIZED|NON_WHITELISTED_IP)$/i;

export const ismartpayConnector: PayoutConnector<IsmartpayPayoutCreds> = {
  id: "ISMARTPAY",
  name: "iSmartPay",
  rails: ["IMPS", "NEFT", "RTGS"],
  creds,
  providerRefFor: (txnRef) => txnRef,
  txnRefFrom: (ref) => ref,

  async transfer(c, t) {
    if (!REF_OK.test(t.ref)) return { ok: false, definite: true, error: "order id has characters iSmartPay may not accept" };
    if (t.rail === "UPI") return { ok: false, definite: true, error: "iSmartPay pays to bank accounts only (no UPI)" };
    if (!t.accountNumber || !t.ifsc) return { ok: false, definite: true, error: "iSmartPay needs the account number and IFSC" };
    const r = await call(c, "POST", "/api/create/payout", {
      amount: Number(rupees(t.amountMinor)),
      currency: "INR",
      purpose: "payout",
      order_id: t.ref,
      narration: (t.purpose.replace(/[^A-Za-z0-9 ]/g, "").trim() || "Payout").slice(0, 30),
      phone_number: c.default_mobile,
      payment_details: {
        type: "NB",
        account_number: t.accountNumber,
        ifsc_code: t.ifsc,
        beneficiary_name: t.beneficiaryName.trim(),
        mode: t.rail,
      },
    });
    if (!r.ok) return r;
    const { httpStatus, body: j } = r.data;
    const code = String(j?.status_code ?? "");
    const message = String(j?.message || j?.errors || code || `http_${httpStatus}`).slice(0, 200);
    if (j?.status === true && j?.transaction_id) {
      const state = ismartpayState(j);
      // A FAIL on creation (e.g. insufficient wallet balance) is confirmed by a lookup before it counts.
      return { ok: true, data: { providerRef: state.providerRef, state } };
    }
    if (REFUSED.test(code)) return { ok: false, definite: true, error: message };
    // DUPLICATE means iSmartPay already has this payout; anything else is unclear. The status
    // lookup settles it; sending again could pay twice.
    return { ok: false, definite: false, error: message };
  },

  async status(c, ref, opts) {
    // iSmartPay looks payouts up by its own transaction id only.
    if (!opts.providerRef) return { ok: false, definite: false, error: "lookup: no iSmartPay transaction id on file yet" };
    const r = await call(c, "GET", `/api/payout/status/${encodeURIComponent(opts.providerRef)}`, undefined, opts.timeoutMs);
    if (!r.ok) return r;
    const { httpStatus, body: j } = r.data;
    if (j?.status === true && j?.status_code) {
      if (j.order_id != null && String(j.order_id) !== ref)
        return { ok: false, definite: false, error: `lookup: iSmartPay answered for ${j.order_id}` };
      return { ok: true, data: ismartpayState(j) };
    }
    const message = String(j?.errors ?? j?.message ?? j?.status_code ?? `http_${httpStatus}`);
    if (/not\s*found|no\s*record|does\s*not\s*exist/i.test(message)) return { ok: true, data: { found: false } };
    return { ok: false, definite: false, error: `lookup: ${message.slice(0, 160)}` };
  },

  async balance(c) {
    const r = await call(c, "GET", "/api/payout/wallet/details", undefined, 8_000);
    if (!r.ok) return r;
    const { httpStatus, body: j } = r.data;
    const bal = paiseFrom(j?.balance);
    if (j?.status !== true || bal == null)
      return { ok: false, definite: false, error: `balance: ${String(j?.errors ?? j?.status_code ?? "http_" + httpStatus).slice(0, 160)}` };
    return { ok: true, data: { balanceMinor: bal, lowBalance: false } };
  },
};
