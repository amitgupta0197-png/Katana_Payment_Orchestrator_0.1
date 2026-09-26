// PayU pay-ins with a Client ID + Client Secret (PayU Payment Links / OneAPI).
//
// For merchants whose PayU account gives Katana a Client ID + Secret rather than the Key + Salt
// (lib/payu-* keeps the Key + Salt path). Stored as gateway PAYU with auth "client_credentials".
//
// Contract (docs.payu.in, Payment Links):
//   token     POST {accounts}/oauth/token  form: client_id, client_secret,
//             grant_type=client_credentials, scope -> { access_token, expires_in }
//             accounts: test https://uat-accounts.payu.in, live https://accounts.payu.in
//   calls     headers Authorization: Bearer <token>, merchantId: <MID>
//             oneapi: test https://uatoneapi.payu.in, live https://oneapi.payu.in
//   create    POST {oneapi}/payment-links (scope create_payment_links)
//             { invoiceNumber (alphanumeric), subAmount, description, source: "API", expiryDate
//               "yyyy-MM-dd HH:mm:ss", customer, successURL, failureURL, udf }
//             -> { status: 0, result: { invoiceNumber, paymentLink, totalAmount, … } } (status -1 = error)
//   link      GET {oneapi}/payment-links/{invoice} (scope read_payment_links)
//             -> { result: { totalAmount, totalAmountCollected, active, status, expiryDate } }
//   txns      GET {oneapi}/payment-links/{invoice}/txns?dateFrom&dateTo (YYYY-MM-DD)
//             -> { result: { data: [{ transactionId, status: "success" | …, mode, settledAmount }] } }
//
// The docs don't state the amount unit; their sample (₹2 -> subAmount 2) is rupees. Katana reads
// the link back and refuses it unless PayU's total equals the order, and settles only on PayU's
// totalAmountCollected, which applyGatewayPayinState checks against the order amount.
// No UPI intent in this mode: the customer pays on PayU's page.
//
// Credentials: MID = mid.mid_code, Client ID = mid.key, Client Secret = mid.salt.

import { createHash } from "crypto";
import type { GatewayMid } from "@/lib/gateway-creds";
import { rupees, type PayinCall, type PayinConnector, type PayinState } from "@/lib/payin-providers/types";

const accounts = (env?: string) => env === "PROD" ? "https://accounts.payu.in" : "https://uat-accounts.payu.in";
const oneapi = (env?: string) => env === "PROD" ? "https://oneapi.payu.in" : "https://uatoneapi.payu.in";

const EXPIRE_MINUTES = 60;
/** How long after the link's expiry Katana still waits before calling an unpaid order failed. */
const EXPIRY_GRACE_MS = 15 * 60_000;

type Scope = "create_payment_links" | "read_payment_links";
const tokens = new Map<string, { token: string; expiresAt: number }>();

async function token(mid: GatewayMid, scope: Scope, fresh = false): Promise<PayinCall<string>> {
  const k = `${mid.env}:${mid.key}:${scope}`;
  const cached = tokens.get(k);
  if (!fresh && cached && cached.expiresAt > Date.now()) return { ok: true, data: cached.token };
  try {
    const res = await fetch(`${accounts(mid.env)}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: mid.key, client_secret: mid.salt, grant_type: "client_credentials", scope,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.access_token)
      return { ok: false, error: `PayU sign-in failed (${scope}): ${String(j?.error_description ?? j?.error ?? j?.message ?? "HTTP " + res.status).slice(0, 160)}` };
    // Renew a minute before PayU's own expiry.
    const ttl = Number(j.expires_in) > 0 ? Number(j.expires_in) * 1000 : 10 * 60_000;
    tokens.set(k, { token: String(j.access_token), expiresAt: Date.now() + ttl - 60_000 });
    return { ok: true, data: String(j.access_token) };
  } catch {
    return { ok: false, error: "PayU sign-in unreachable" };
  }
}

async function call(mid: GatewayMid, scopes: Scope[], path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<PayinCall<{ httpStatus: number; body: any }>> {
  let lastError = "PayU unreachable";
  // A read can fall back to the create scope: some accounts are issued only create_payment_links.
  for (const scope of scopes) {
    for (const fresh of [false, true]) {
      const t = await token(mid, scope, fresh);
      if (!t.ok) { lastError = t.error; break; }
      try {
        const res = await fetch(`${oneapi(mid.env)}${path}`, {
          method: init.method,
          headers: {
            Authorization: `Bearer ${t.data}`, merchantId: mid.mid_code, Accept: "application/json",
            ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 401 && !fresh) continue;
        if (res.status === 401 || res.status === 403) { lastError = `PayU refused the ${scope} token (HTTP ${res.status})`; break; }
        const text = await res.text();
        try { return { ok: true, data: { httpStatus: res.status, body: JSON.parse(text) } }; }
        catch { return { ok: false, error: `PayU returned a non-JSON reply (HTTP ${res.status})` }; }
      } catch {
        return { ok: false, error: "PayU unreachable" };
      }
    }
  }
  return { ok: false, error: lastError };
}

/** PayU invoice numbers are alphanumeric; Katana txnids may not be. Deterministic either way. */
export function payuInvoiceOf(txnid: string): string {
  if (/^[A-Za-z0-9]{1,40}$/.test(txnid)) return txnid;
  const h = createHash("sha256").update(txnid).digest("hex").slice(0, 10);
  return `${txnid.replace(/[^A-Za-z0-9]/g, "").slice(0, 29)}K${h}`;
}

/** "yyyy-MM-dd HH:mm:ss" (or just the date) in India time, which is what PayU's dashboard uses. */
function ist(d: Date, dateOnly = false): string {
  const t = new Date(d.getTime() + 330 * 60_000).toISOString();
  return dateOnly ? t.slice(0, 10) : `${t.slice(0, 10)} ${t.slice(11, 19)}`;
}

function paise(v: unknown): bigint | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? BigInt(Math.round(n * 100)) : null;
}

function payuError(body: any, httpStatus: number): string {
  return String(body?.message ?? body?.errorCode ?? `HTTP ${httpStatus}`).slice(0, 200);
}

export const payuLinksPayin: PayinConnector = {
  id: "PAYU",
  name: "PayU",
  path: "payu-links",

  async checkout(mid, o) {
    if (o.currency !== "INR") return { ok: false, error: "PayU Payment Links are INR only" };
    const amount = rupees(o.amountMinor);
    const invoice = payuInvoiceOf(o.txnid);
    const r = await call(mid, ["create_payment_links"], "/payment-links", {
      method: "POST",
      body: {
        invoiceNumber: invoice,
        subAmount: Number(amount),
        isAmountFilledByCustomer: false,
        isPartialPaymentAllowed: false,
        description: (o.productinfo || "Order").slice(0, 100),
        source: "API",
        expiryDate: ist(new Date(Date.now() + EXPIRE_MINUTES * 60_000)),
        customer: { name: o.firstname || "Customer", email: o.email || undefined, phone: o.phone || undefined },
        successURL: o.returnUrl,
        failureURL: o.returnUrl,
        udf: { udf1: o.txnid },
      },
    });
    if (!r.ok) return r;
    const b = r.data.body;
    if (b?.status !== 0 || !b?.result) return { ok: false, error: `PayU refused the payment link: ${payuError(b, r.data.httpStatus)}` };
    const link = String(b.result.paymentLink ?? "");
    if (!/^https?:\/\//i.test(link)) return { ok: false, error: "PayU returned no payment link" };
    if (String(b.result.invoiceNumber ?? invoice) !== invoice) return { ok: false, error: "PayU returned a link for a different invoice" };
    // Never send the customer to a link for a different amount (e.g. if PayU read it in paise).
    const total = paise(b.result.totalAmount ?? b.result.subAmount);
    if (total !== o.amountMinor) return { ok: false, error: `PayU's link is for ₹${total == null ? "?" : rupees(total)}, not ₹${amount}; not used` };
    return { ok: true, data: { kind: "redirect", url: link } };
  },

  async status(mid, txnid): Promise<PayinCall<PayinState>> {
    const invoice = payuInvoiceOf(txnid);
    const l = await call(mid, ["read_payment_links", "create_payment_links"], `/payment-links/${encodeURIComponent(invoice)}`, { method: "GET" });
    if (!l.ok) return l;
    const lb = l.data.body;
    if (lb?.status !== 0 || !lb?.result) {
      if (/not\s*found/i.test(String(lb?.message ?? "")) || l.data.httpStatus === 404) return { ok: true, data: { found: false } };
      return { ok: false, error: `PayU link lookup failed: ${payuError(lb, l.data.httpStatus)}` };
    }
    const link = lb.result;

    // The payments made on the link, for the payment id and mode. Optional: the link's own
    // totals decide the outcome.
    const now = new Date();
    const q = new URLSearchParams({
      dateFrom: ist(new Date(now.getTime() - 7 * 86_400_000), true),
      dateTo: ist(new Date(now.getTime() + 86_400_000), true),
      pageSize: "20", pageOffset: "0",
    });
    const t = await call(mid, ["read_payment_links", "create_payment_links"], `/payment-links/${encodeURIComponent(invoice)}/txns?${q}`, { method: "GET" });
    const txns: any[] = t.ok && Array.isArray(t.data.body?.result?.data) ? t.data.body.result.data : [];
    const paid = txns.find((x) => String(x?.status ?? "").toLowerCase() === "success");
    const last = paid ?? txns[0];

    const collected = paise(link.totalAmountCollected) ?? 0n;
    const expiry = Date.parse(String(link.expiryDate ?? "").replace(" ", "T") + (/[+Z]/.test(String(link.expiryDate ?? "").slice(10)) ? "" : "+05:30"));
    const closed = link.active === false || /expired|inactive|cancel/i.test(String(link.status ?? ""))
      || (Number.isFinite(expiry) && expiry + EXPIRY_GRACE_MS < now.getTime());

    // SUCCESS only on money PayU says it collected; its amount must then equal the order's.
    // A "success" payment whose collection hasn't reached the link yet waits for the next check.
    // FAILED only when the link is closed AND PayU's payment list was read and shows no success.
    const final: PayinState["final"] = collected > 0n ? "SUCCESS" : t.ok && !paid && closed ? "FAILED" : null;
    return {
      ok: true,
      data: {
        found: true, final,
        status: collected > 0n ? "PAID" : String(last?.status ?? link.status ?? "active").toUpperCase(),
        paymentId: last?.transactionId != null ? String(last.transactionId) : undefined,
        amountMinor: collected > 0n ? collected : undefined,
        mode: last?.mode != null ? String(last.mode) : undefined,
        raw: { invoice, link_status: link.status ?? null, active: link.active ?? null, total_collected: link.totalAmountCollected ?? null, txns: txns.slice(0, 5) },
      },
    };
  },
};
