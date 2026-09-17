// RazorpayX Payouts — money OUT from a merchant's own RazorpayX account.
//
// Contract (razorpay.com/docs/api/x):
//   auth      HTTP Basic key_id:key_secret. Test and live differ only by key (rzp_test_ / rzp_live_);
//             the host is the same.
//   transfer  POST /v1/payouts  (composite: contact + fund account inline)
//             header X-Payout-Idempotency: <key>  — Razorpay returns the same payout for a repeated
//             key, so a retry after a timeout can't pay twice. Katana uses the txn_ref.
//             body { account_number, amount (paise), currency, mode, purpose, fund_account{...},
//                    queue_if_low_balance, reference_id, narration, notes }
//             -> payout entity { id: pout_…, status, utr, amount, failure_reason, status_details }
//             -> 4xx { error: { code, description, ... } }  refused, nothing created
//   status    GET /v1/payouts/:id, or GET /v1/payouts?account_number=&reference_id=
//   list      GET /v1/payouts?account_number=&from=&to=&count=100&skip=   (unix seconds)
//   webhook   set in the RazorpayX dashboard (no API); body signed with the webhook secret:
//             X-Razorpay-Signature = hex HMAC-SHA256(raw body, webhook_secret)
//
// Payout statuses: queued, pending, scheduled, processing -> in flight; processed -> paid;
// reversed -> paid then returned; failed, rejected, cancelled -> not paid.

import { createHmac, timingSafeEqual } from "crypto";
import { getPayoutGateway } from "@/lib/payout-gateway";
import type { GatewayEnv } from "@/lib/pg-catalog";
import { istDay, type PayoutConnector, type ProviderCall, type TransferState } from "@/lib/payout-providers/types";

export interface RazorpayPayoutCreds {
  env: GatewayEnv;
  key_id: string;
  key_secret: string;
  account_number: string;
  webhook_secret?: string;
}

const API = "https://api.razorpay.com/v1";

async function creds(merchantCode: string): Promise<RazorpayPayoutCreds | null> {
  const g = await getPayoutGateway(merchantCode);
  if (!g || g.gateway !== "RAZORPAY") return null;
  const { key_id, key_secret, account_number, webhook_secret } = g.fields;
  if (!key_id || !key_secret || !account_number) return null;
  return { env: g.env, key_id, key_secret, account_number, webhook_secret };
}

async function call(c: RazorpayPayoutCreds, path: string, init: { method: "GET" | "POST"; body?: unknown; idempotencyKey?: string; timeoutMs?: number }): Promise<ProviderCall<{ httpStatus: number; body: any }>> {
  try {
    const headers: Record<string, string> = {
      Authorization: "Basic " + Buffer.from(`${c.key_id}:${c.key_secret}`).toString("base64"),
      Accept: "application/json",
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.idempotencyKey) headers["X-Payout-Idempotency"] = init.idempotencyKey;
    const res = await fetch(`${API}${path}`, {
      method: init.method, headers,
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

const errText = (b: any, status: number) =>
  String(b?.error?.description ?? b?.error?.reason ?? b?.error?.code ?? `http_${status}`).slice(0, 200);

function finalOf(s: string): TransferState["final"] {
  if (s === "processed") return "SUCCESS";
  if (s === "reversed") return "REVERSED";
  if (s === "failed" || s === "rejected" || s === "cancelled") return "FAILED";
  return null;
}

function toState(p: any): TransferState & { ref: string } {
  const status = String(p?.status ?? "").toLowerCase();
  const why = p?.status_details?.description ?? p?.failure_reason ?? p?.status_details?.reason;
  return {
    found: true,
    ref: String(p?.reference_id ?? ""),
    final: finalOf(status),
    status: status.toUpperCase(),
    providerRef: p?.id ? String(p.id) : undefined,
    bankRef: p?.utr ? String(p.utr) : undefined,
    amountMinor: p?.amount != null && Number.isFinite(Number(p.amount)) ? BigInt(Math.trunc(Number(p.amount))) : undefined,
    msg: why ? String(why) : undefined,
    raw: p,
  };
}

// Narration: letters, digits and spaces only, at most 30 characters.
const narration = (s: string) => s.replace(/[^A-Za-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 30) || "Payout";

// IST day boundaries as unix seconds.
const dayStart = (d: Date) => Math.floor(new Date(`${istDay(d)}T00:00:00+05:30`).getTime() / 1000);

export const razorpayConnector: PayoutConnector<RazorpayPayoutCreds> = {
  id: "RAZORPAY",
  name: "RazorpayX",
  rails: ["IMPS", "NEFT", "RTGS", "UPI"],
  creds,
  providerRefFor: (txnRef) => txnRef,
  txnRefFrom: (ref) => ref,

  async transfer(c, t) {
    const contact = { name: t.beneficiaryName.slice(0, 50), type: "customer", reference_id: t.txnRef };
    const fund_account = t.rail === "UPI"
      ? { account_type: "vpa", vpa: { address: t.vpa }, contact }
      : { account_type: "bank_account", bank_account: { name: t.beneficiaryName.slice(0, 120), ifsc: t.ifsc, account_number: t.accountNumber }, contact };
    const r = await call(c, "/payouts", {
      method: "POST", idempotencyKey: t.ref,
      body: {
        account_number: c.account_number,
        amount: Number(t.amountMinor),
        currency: "INR",
        mode: t.rail,
        purpose: "payout",
        fund_account,
        // A short balance holds the payout in RazorpayX's queue instead of refusing it; the
        // status sweep keeps watching it.
        queue_if_low_balance: true,
        reference_id: t.ref,
        narration: narration(t.purpose),
        notes: { katana_txn_ref: t.txnRef, purpose: t.purpose.slice(0, 250) },
      },
    });
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    if (httpStatus >= 200 && httpStatus < 300 && body?.entity === "payout" && body?.id) {
      return { ok: true, data: { providerRef: String(body.id), state: toState(body) } };
    }
    // Razorpay validated the request and refused it: no payout was created. Auth failures are
    // refusals too. Rate limits and server errors are not answers.
    if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 409 && httpStatus !== 429 && body?.error) {
      return { ok: false, definite: true, error: errText(body, httpStatus) };
    }
    return { ok: false, definite: false, error: errText(body, httpStatus) };
  },

  async status(c, ref, opts) {
    if (opts.providerRef) {
      const r = await call(c, `/payouts/${encodeURIComponent(opts.providerRef)}`, { method: "GET", timeoutMs: opts.timeoutMs });
      if (!r.ok) return r;
      const { httpStatus, body } = r.data;
      if (httpStatus === 200 && body?.entity === "payout") {
        // Only trust it if it is the payout we sent.
        if (String(body.reference_id ?? "") !== ref)
          return { ok: false, definite: false, error: `lookup: payout ${opts.providerRef} has reference ${body.reference_id}` };
        return { ok: true, data: toState(body) };
      }
      if (httpStatus !== 400 && httpStatus !== 404) return { ok: false, definite: false, error: `lookup: ${errText(body, httpStatus)}` };
      // Fall through to the search by reference.
    }
    const q = new URLSearchParams({ account_number: c.account_number, reference_id: ref });
    const r = await call(c, `/payouts?${q}`, { method: "GET", timeoutMs: opts.timeoutMs });
    if (!r.ok) return r;
    const { httpStatus, body } = r.data;
    if (httpStatus !== 200 || !Array.isArray(body?.items))
      return { ok: false, definite: false, error: `lookup: ${errText(body, httpStatus)}` };
    const hits = body.items.filter((p: any) => String(p?.reference_id ?? "") === ref);
    if (!hits.length) return { ok: true, data: { found: false } };
    if (hits.length > 1) return { ok: false, definite: false, error: `lookup: ${hits.length} payouts carry reference ${ref}` };
    return { ok: true, data: toState(hits[0]) };
  },

  async list(c, from, to) {
    const out: (TransferState & { ref: string })[] = [];
    const window = { from: String(dayStart(from)), to: String(dayStart(to) + 86_400 - 1) };
    for (let skip = 0; skip < 20_000; skip += 100) {
      const q = new URLSearchParams({ account_number: c.account_number, ...window, count: "100", skip: String(skip) });
      const r = await call(c, `/payouts?${q}`, { method: "GET", timeoutMs: 30_000 });
      if (!r.ok) return r;
      const { httpStatus, body } = r.data;
      if (httpStatus !== 200 || !Array.isArray(body?.items))
        return { ok: false, definite: false, error: `list: ${errText(body, httpStatus)}` };
      out.push(...body.items.map(toState));
      if (body.items.length < 100) return { ok: true, data: out };
    }
    return { ok: false, definite: false, error: "list: more than 20,000 payouts; narrow the date range" };
  },
};

/** Is this RazorpayX webhook body signed with the merchant's webhook secret? */
export function razorpayWebhookSignatureOk(c: RazorpayPayoutCreds, rawBody: string, signature: string | null): boolean {
  if (!c.webhook_secret || !signature) return false;
  const want = Buffer.from(createHmac("sha256", c.webhook_secret).update(rawBody).digest("hex"));
  const got = Buffer.from(signature.trim());
  return got.length === want.length && timingSafeEqual(got, want);
}
