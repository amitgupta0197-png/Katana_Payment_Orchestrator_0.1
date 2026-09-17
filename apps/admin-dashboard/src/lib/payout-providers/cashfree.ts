// Cashfree Payouts (API v2, x-api-version 2024-01-01) — money OUT from a merchant's own
// Cashfree Payouts account.
//
// Contract (cashfree.com/docs/api-reference/payouts/v2):
//   hosts     sandbox https://sandbox.cashfree.com/payout, production https://api.cashfree.com/payout
//   auth      headers x-client-id / x-client-secret (Payouts keys, not the PG keys). Cashfree also
//             requires two-factor auth on Payouts: Katana's server IP must be whitelisted in the
//             Cashfree Payouts dashboard, or every call is refused with 403.
//   transfer  POST /transfers
//             body { transfer_id, transfer_amount (rupees), transfer_currency, transfer_mode,
//                    beneficiary_details { beneficiary_name, beneficiary_instrument_details {
//                      bank_account_number, bank_ifsc | vpa } }, transfer_remarks }
//             -> transfer { transfer_id, cf_transfer_id, status, status_code, status_description, ... }
//             -> 4xx { message, code, type }  refused
//   status    GET /transfers?transfer_id=   -> transfer, 404 when Cashfree has no such transfer
//   webhook   set in the Cashfree dashboard. v2 events are signed:
//             x-webhook-signature = base64 HMAC-SHA256(x-webhook-timestamp + raw body, client secret)
//             v1 (form) events carry a `signature` field over the sorted other fields.
//
// transfer_id allows letters, digits and underscores, so Katana's TXN-… reference is sent with
// the hyphen replaced (TXN_…). Katana's references are hex after the prefix, so this reverses.
//
// Transfer statuses: SUCCESS -> paid; REVERSED -> paid then returned; FAILED, REJECTED,
// MANUALLY_REJECTED, CANCELLED -> not paid; anything else (RECEIVED, PENDING, QUEUED,
// APPROVAL_PENDING, SCHEDULED, ...) -> in flight.

import { createHmac, timingSafeEqual } from "crypto";
import { getPayoutGateway } from "@/lib/payout-gateway";
import type { GatewayEnv } from "@/lib/pg-catalog";
import { paiseFrom, rupees, type PayoutConnector, type ProviderCall, type TransferState } from "@/lib/payout-providers/types";

export interface CashfreePayoutCreds {
  env: GatewayEnv;
  client_id: string;
  client_secret: string;
}

const base = (env: GatewayEnv) => (env === "PROD" ? "https://api.cashfree.com/payout" : "https://sandbox.cashfree.com/payout");

async function creds(merchantCode: string): Promise<CashfreePayoutCreds | null> {
  const g = await getPayoutGateway(merchantCode);
  if (!g || g.gateway !== "CASHFREE") return null;
  const { client_id, client_secret } = g.fields;
  if (!client_id || !client_secret) return null;
  return { env: g.env, client_id, client_secret };
}

async function call(c: CashfreePayoutCreds, path: string, init: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number }): Promise<ProviderCall<{ httpStatus: number; body: any }>> {
  try {
    const res = await fetch(`${base(c.env)}${path}`, {
      method: init.method,
      headers: {
        "x-client-id": c.client_id, "x-client-secret": c.client_secret,
        "x-api-version": "2024-01-01", Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    try { return { ok: true, data: { httpStatus: res.status, body: JSON.parse(text) } }; }
    catch { return { ok: false, definite: false, error: `http_${res.status}: non-JSON reply` }; }
  } catch {
    return { ok: false, definite: false, error: "unreachable" };
  }
}

const errText = (b: any, status: number) => String(b?.message ?? b?.code ?? `http_${status}`).slice(0, 200);

function finalOf(s: string): TransferState["final"] {
  if (s === "SUCCESS") return "SUCCESS";
  if (s === "REVERSED") return "REVERSED";
  if (s === "FAILED" || s === "REJECTED" || s === "MANUALLY_REJECTED" || s === "CANCELLED") return "FAILED";
  return null;
}

function toState(t: any): TransferState & { ref: string } {
  const status = String(t?.status ?? "").toUpperCase();
  const utr = t?.utr ?? t?.bank_reference_number ?? t?.transfer_utr;
  return {
    found: true,
    ref: String(t?.transfer_id ?? ""),
    final: finalOf(status),
    status,
    providerRef: t?.cf_transfer_id != null ? String(t.cf_transfer_id) : undefined,
    bankRef: utr ? String(utr) : undefined,
    amountMinor: paiseFrom(t?.transfer_amount),
    msg: t?.status_description ? String(t.status_description) : t?.status_code ? String(t.status_code) : undefined,
    raw: t,
  };
}

const remarks = (s: string) => s.replace(/[^A-Za-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 70) || "Payout";

export const cashfreeConnector: PayoutConnector<CashfreePayoutCreds> = {
  id: "CASHFREE",
  name: "Cashfree Payouts",
  rails: ["IMPS", "NEFT", "RTGS", "UPI"],
  creds,
  providerRefFor: (txnRef) => txnRef.replace(/-/g, "_"),
  txnRefFrom: (ref) => ref.replace(/_/g, "-"),

  async transfer(c, t) {
    const instrument = t.rail === "UPI"
      ? { vpa: t.vpa }
      : { bank_account_number: t.accountNumber, bank_ifsc: t.ifsc };
    const r = await call(c, "/transfers", {
      method: "POST",
      body: {
        transfer_id: t.ref,
        transfer_amount: Number(rupees(t.amountMinor)),
        transfer_currency: "INR",
        transfer_mode: t.rail.toLowerCase(),
        beneficiary_details: {
          beneficiary_name: t.beneficiaryName.slice(0, 100),
          beneficiary_instrument_details: instrument,
        },
        transfer_remarks: remarks(t.purpose),
      },
    });
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    if (httpStatus >= 200 && httpStatus < 300 && body?.transfer_id) {
      return { ok: true, data: { providerRef: body.cf_transfer_id != null ? String(body.cf_transfer_id) : undefined, state: toState(body) } };
    }
    // 409: a transfer with this id already exists — Cashfree has it; the lookup says how it went.
    // Rate limits and server errors are not answers either. Other 4xx: refused, nothing sent.
    if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 409 && httpStatus !== 429 && (body?.message || body?.code)) {
      return { ok: false, definite: true, error: errText(body, httpStatus) };
    }
    return { ok: false, definite: false, error: errText(body, httpStatus) };
  },

  async status(c, ref, opts) {
    const r = await call(c, `/transfers?${new URLSearchParams({ transfer_id: ref })}`, { method: "GET", timeoutMs: opts.timeoutMs });
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    if (httpStatus === 404) return { ok: true, data: { found: false } };
    if (httpStatus !== 200 || !body?.transfer_id)
      return { ok: false, definite: false, error: `lookup: ${errText(body, httpStatus)}` };
    if (String(body.transfer_id) !== ref)
      return { ok: false, definite: false, error: `lookup: Cashfree answered for ${body.transfer_id}` };
    return { ok: true, data: toState(body) };
  },
};

/** Transfer reference and event name from a Cashfree payout webhook (v2 JSON or v1 form). */
export function cashfreeWebhookRef(body: Record<string, any>): { ref: string; event: string } {
  const data = body?.data ?? {};
  const ref = data.transfer_id ?? data.transfer?.transfer_id ?? body.transferId ?? body.transfer_id ?? "";
  return { ref: String(ref), event: String(body.type ?? body.event ?? "").toUpperCase() };
}

/** Is this Cashfree payout webhook signed with the merchant's client secret? */
export function cashfreeWebhookSignatureOk(c: CashfreePayoutCreds, rawBody: string, headers: Headers, form: Record<string, string> | null): boolean {
  const eq = (a: string, b: string) => {
    const x = Buffer.from(a); const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };
  const sig = headers.get("x-webhook-signature");
  const ts = headers.get("x-webhook-timestamp");
  if (sig && ts) {
    return eq(sig.trim(), createHmac("sha256", c.client_secret).update(ts + rawBody).digest("base64"));
  }
  if (form?.signature) {
    const data = Object.keys(form).filter((k) => k !== "signature").sort().map((k) => form[k]).join("");
    return eq(form.signature, createHmac("sha256", c.client_secret).update(data).digest("base64"));
  }
  return false;
}
