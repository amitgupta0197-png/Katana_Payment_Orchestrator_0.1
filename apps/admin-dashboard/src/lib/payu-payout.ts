// PayU Payouts API client — money OUT from a merchant's own PayU Payouts account.
//
// PayU Payouts is a separate product from PayU checkout, with separate credentials: a
// private Client ID + Client Secret (Payouts dashboard) that buy a short-lived OAuth token,
// and a payoutMerchantId that differs from the checkout MID. They are sealed in the vault
// next to the checkout Key + Salt under their own label, and never leave the server.
//
// Contract (docs.payu.in, Payouts):
//   token     POST {accounts}/oauth/token   form: grant_type=client_credentials, client_id,
//             client_secret, scope=create_payout_transactions -> { access_token, expires_in }
//   transfer  POST {api}/payout/v2/payment (UAT) | /payout/payment (PROD)
//             body: JSON array of { merchantRefId, amount, purpose, paymentType, ... }
//             -> { status: 0 } accepted, result follows by webhook
//             -> { status: 1, data: [{ merchantRefId, error, code }] } refused
//   status    POST {api}/payout/payment/listTransactions   form: merchantRefId, from, to
//             -> data.transactionDetails[{ merchantRefId, txnStatus, payuTransactionRefNo, amount, msg }]
//   balance   GET  {api}/payout/merchant/getAccountDetail -> data.balance
//   webhook   POST {api}/payout/v2/webhook  body: [{ webhook, values: { url, authorization } }]
//   Every API call carries `Authorization: Bearer <token>` and the payoutMerchantId header.
//
// Two gaps in PayU's docs that UAT must settle: the transfer endpoint documents the merchant
// header as `pid` (the others use `payoutMerchantId`), so both are sent; and it is labelled
// form-encoded while its body is a JSON array, so it is sent as JSON.
//
// Like the pay-in client, nothing here throws. A call that got no usable answer reports
// definite=false: the caller must treat that as "unknown", never as "failed". A payout marked
// failed while PayU is actually paying it invites the merchant to pay the same person twice.

import { randomBytes, timingSafeEqual } from "crypto";
import { getPayoutGateway, storePayoutGateway } from "@/lib/payout-gateway";
import { payoutWebhookUrlFor, type PayoutRail } from "@/lib/payout-providers/types";

export type PayuEnv = "TEST" | "PROD";
export type { PayoutRail };

export interface PayuPayoutCreds {
  client_id: string;
  client_secret: string;
  payout_merchant_id: string;
  env: PayuEnv;
  /** Shared secret registered with PayU's Set Webhook API; PayU echoes it on every event. */
  webhook_token?: string;
  webhook_registered_at?: string;
}

/**
 * The merchant's PayU payout credentials, or null when their payout gateway isn't PayU.
 * Everything that sends a PayU payout starts here, so a merchant on another payout gateway
 * can never be paid through PayU by mistake.
 */
export async function getPayuPayoutCreds(merchantCode: string): Promise<PayuPayoutCreds | null> {
  const g = await getPayoutGateway(merchantCode);
  if (!g || g.gateway !== "PAYU") return null;
  const { client_id, client_secret, payout_merchant_id } = g.fields;
  if (!client_id || !client_secret || !payout_merchant_id) return null;
  return { client_id, client_secret, payout_merchant_id, env: g.env, webhook_token: g.webhook_token, webhook_registered_at: g.webhook_registered_at };
}

/** Save PayU payout credentials back (after a webhook registration). */
export async function storePayuPayoutCreds(merchantCode: string, c: PayuPayoutCreds): Promise<void> {
  await storePayoutGateway(merchantCode, {
    gateway: "PAYU", env: c.env,
    fields: { client_id: c.client_id, client_secret: c.client_secret, payout_merchant_id: c.payout_merchant_id },
    webhook_token: c.webhook_token, webhook_registered_at: c.webhook_registered_at,
  });
}

function accountsBase(env: PayuEnv): string {
  return env === "PROD" ? "https://accounts.payu.in" : "https://uat-accounts.payu.in";
}
function apiBase(env: PayuEnv): string {
  return env === "PROD" ? "https://payout.payumoney.com" : "https://uatoneapi.payu.in";
}
function transferUrl(env: PayuEnv): string {
  return env === "PROD" ? `${apiBase(env)}/payout/payment` : `${apiBase(env)}/payout/v2/payment`;
}

export type PayuCall<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; definite: boolean };

// ── OAuth token ──────────────────────────────────────────────────────────────
// Tokens live in process memory only. A restart simply fetches a new one.
const tokens = new Map<string, { token: string; expiresAt: number }>();
const tokenKey = (c: PayuPayoutCreds) => `${c.env}:${c.client_id}`;

async function accessToken(c: PayuPayoutCreds, fresh = false): Promise<PayuCall<string>> {
  const cached = tokens.get(tokenKey(c));
  if (!fresh && cached && cached.expiresAt > Date.now()) return { ok: true, data: cached.token };

  const body = new URLSearchParams({
    grant_type: "client_credentials", client_id: c.client_id,
    client_secret: c.client_secret, scope: "create_payout_transactions",
  });
  try {
    const res = await fetch(`${accountsBase(c.env)}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.access_token) {
      // A wrong Client ID / Secret is the usual cause; PayU's message says so.
      return { ok: false, definite: false, error: `token: ${String(j?.error_description ?? j?.error ?? "http_" + res.status).slice(0, 160)}` };
    }
    const ttlMs = Math.max(0, Number(j.expires_in ?? 0) * 1000 - 60_000); // renew a minute early
    tokens.set(tokenKey(c), { token: String(j.access_token), expiresAt: Date.now() + ttlMs });
    return { ok: true, data: String(j.access_token) };
  } catch {
    return { ok: false, definite: false, error: "token: unreachable" };
  }
}

// One authenticated call. A 401 means the cached token died early: fetch a new one, retry once.
async function call(c: PayuPayoutCreds, url: string, init: { method: "GET" | "POST"; contentType: string; body?: string; timeoutMs?: number }): Promise<PayuCall<any>> {
  for (const fresh of [false, true]) {
    const t = await accessToken(c, fresh);
    if (!t.ok) return t;
    try {
      const res = await fetch(url, {
        method: init.method,
        headers: {
          "Content-Type": init.contentType, Accept: "application/json",
          Authorization: `Bearer ${t.data}`,
          payoutMerchantId: c.payout_merchant_id, pid: c.payout_merchant_id,
        },
        body: init.body,
        signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
      });
      if (res.status === 401 && !fresh) { tokens.delete(tokenKey(c)); continue; }
      const text = await res.text();
      let j: any;
      try { j = JSON.parse(text); } catch {
        return { ok: false, definite: false, error: `http_${res.status}: non-JSON reply` };
      }
      return { ok: true, data: { httpStatus: res.status, body: j } };
    } catch {
      return { ok: false, definite: false, error: "unreachable" };
    }
  }
  return { ok: false, definite: false, error: "unauthorized" };
}

// ── Transfer ─────────────────────────────────────────────────────────────────
export interface PayuTransferInput {
  merchantRefId: string;          // our txn_ref — max 40 chars, unique per transfer
  amountMinor: bigint;            // paise
  rail: PayoutRail;
  purpose: string;
  beneficiaryName: string;
  accountNumber?: string | null;
  ifsc?: string | null;
  vpa?: string | null;
}

/** Ask PayU to pay. ok=true only means PayU accepted the request; the result comes later. */
export async function payuTransfer(c: PayuPayoutCreds, t: PayuTransferInput): Promise<PayuCall<{ accepted: true }>> {
  const item: Record<string, unknown> = {
    merchantRefId: t.merchantRefId,
    amount: Number(t.amountMinor) / 100,
    purpose: t.purpose.slice(0, 50),
    paymentType: t.rail,
    beneficiaryName: t.beneficiaryName,
    batchId: "katana",
    // Katana has already approved this payout (whitelist + maker-checker); PayU's own
    // dashboard approval would leave it stuck waiting for a click nobody knows to make.
    disableApprovalFlow: true,
  };
  if (t.rail === "UPI") item.vpa = t.vpa;
  else { item.beneficiaryAccountNumber = t.accountNumber; item.beneficiaryIfscCode = t.ifsc; }

  const r = await call(c, transferUrl(c.env), { method: "POST", contentType: "application/json", body: JSON.stringify([item]) });
  if (!r.ok) return r;
  const { httpStatus, body } = r.data;
  if (body?.status === 0 || body?.status === "0") return { ok: true, data: { accepted: true } };
  if (body?.status === 1 || body?.status === "1") {
    // PayU refused the request outright — nothing was sent to the bank.
    const row = Array.isArray(body.data) ? body.data.find((d: any) => d?.merchantRefId === t.merchantRefId) ?? body.data[0] : null;
    const why = row?.error ?? body.msg ?? `code ${JSON.stringify(row?.code ?? body.code)}`;
    return { ok: false, definite: true, error: String(why).slice(0, 200) };
  }
  return { ok: false, definite: false, error: `http_${httpStatus}: unexpected reply` };
}

// ── Status lookup ────────────────────────────────────────────────────────────
export type PayuTxnStatus = "QUEUED" | "SCHEDULED" | "IN_PROGRESS" | "PENDING" | "SUCCESS" | "FAILED" | "WAITING_FOR_RETRY" | "REVERSED" | string;

export interface PayuTransferState {
  found: boolean;
  status?: PayuTxnStatus;
  payuRef?: string;
  bankRef?: string;
  amountMinor?: bigint;
  msg?: string;
  raw?: Record<string, unknown>;
}

// listTransactions filters by date (DD/MM/YYYY). Without a range PayU searches a default
// window, so pass one that surely contains the payout: its creation day (IST) minus a day,
// through today.
export function istDate(d: Date): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")}`;
}

/**
 * What PayU says happened to one transfer. found=false with ok=true is PayU saying it has no
 * such transfer — which, for a payout sent moments ago, may just be lag. Never fail on it alone.
 */
export async function payuTransferStatus(c: PayuPayoutCreds, merchantRefId: string, createdAt: Date, timeoutMs?: number): Promise<PayuCall<PayuTransferState>> {
  const body = new URLSearchParams({
    merchantRefId,
    from: istDate(new Date(createdAt.getTime() - 86_400_000)),
    to: istDate(new Date()),
    page: "1", pageSize: "10",
  });
  const r = await call(c, `${apiBase(c.env)}/payout/payment/listTransactions`, {
    method: "POST", contentType: "application/x-www-form-urlencoded", body: body.toString(), timeoutMs,
  });
  if (!r.ok) return r;
  const { httpStatus, body: j } = r.data;
  if (j?.status !== 0 && j?.status !== "0") {
    return { ok: false, definite: false, error: `lookup: ${String(j?.msg ?? "http_" + httpStatus).slice(0, 160)}` };
  }
  // PayU: "determine the status only from txnStatus of the entry matching merchantRefId".
  const rows: any[] = Array.isArray(j?.data?.transactionDetails) ? j.data.transactionDetails : [];
  const d = rows.find((x) => String(x?.merchantRefId) === merchantRefId);
  if (!d) return { ok: true, data: { found: false } };
  return { ok: true, data: transferState(d) };
}

function transferState(d: any): PayuTransferState & { merchantRefId: string } {
  let amountMinor: bigint | undefined;
  if (d.amount != null && Number.isFinite(Number(d.amount))) amountMinor = BigInt(Math.round(Number(d.amount) * 100));
  return {
    found: true,
    merchantRefId: String(d.merchantRefId ?? ""),
    status: String(d.txnStatus ?? "").toUpperCase(),
    payuRef: d.payuTransactionRefNo ? String(d.payuTransactionRefNo) : undefined,
    bankRef: d.bankTransactionRefNo ? String(d.bankTransactionRefNo) : d.utr ? String(d.utr) : undefined,
    amountMinor,
    msg: d.msg ? String(d.msg) : undefined,
    raw: d,
  };
}

/** Every transfer PayU has for a date range (IST days, inclusive), for reconciliation. */
export async function payuListTransfers(c: PayuPayoutCreds, from: Date, to: Date, maxPages = 20): Promise<PayuCall<(PayuTransferState & { merchantRefId: string })[]>> {
  const out: (PayuTransferState & { merchantRefId: string })[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const body = new URLSearchParams({ from: istDate(from), to: istDate(to), page: String(page), pageSize: "1000" });
    const r = await call(c, `${apiBase(c.env)}/payout/payment/listTransactions`, {
      method: "POST", contentType: "application/x-www-form-urlencoded", body: body.toString(), timeoutMs: 30_000,
    });
    if (!r.ok) return r;
    const { httpStatus, body: j } = r.data;
    if (j?.status !== 0 && j?.status !== "0")
      return { ok: false, definite: false, error: `list: ${String(j?.msg ?? "http_" + httpStatus).slice(0, 160)}` };
    const rows: any[] = Array.isArray(j?.data?.transactionDetails) ? j.data.transactionDetails : [];
    out.push(...rows.map(transferState));
    const pages = Number(j?.data?.noOfPages ?? 1);
    if (!rows.length || page >= pages) return { ok: true, data: out };
  }
  return { ok: false, definite: false, error: `list: more than ${maxPages} pages; narrow the date range` };
}

// ── Balance ──────────────────────────────────────────────────────────────────
export async function payuPayoutBalance(c: PayuPayoutCreds): Promise<PayuCall<{ balanceMinor: bigint; lowBalance: boolean }>> {
  const r = await call(c, `${apiBase(c.env)}/payout/merchant/getAccountDetail`, {
    method: "GET", contentType: "application/x-www-form-urlencoded", timeoutMs: 8_000,
  });
  if (!r.ok) return r;
  const { httpStatus, body: j } = r.data;
  const bal = Number(j?.data?.balance);
  if ((j?.status !== 0 && j?.status !== "0") || !Number.isFinite(bal)) {
    return { ok: false, definite: false, error: `balance: ${String(j?.msg ?? "http_" + httpStatus).slice(0, 160)}` };
  }
  return { ok: true, data: { balanceMinor: BigInt(Math.round(bal * 100)), lowBalance: Boolean(j.data.lowBalance) } };
}

// ── Webhook registration ─────────────────────────────────────────────────────
export function payoutWebhookUrl(): string {
  return payoutWebhookUrlFor("PAYU");
}

/** Register Katana's webhook as the account default, with a fresh shared token. */
export async function registerPayuPayoutWebhook(c: PayuPayoutCreds): Promise<PayuCall<{ token: string; url: string }>> {
  const token = randomBytes(24).toString("hex");
  const url = payoutWebhookUrl();
  const r = await call(c, `${apiBase(c.env)}/payout/v2/webhook`, {
    method: "POST", contentType: "application/json",
    body: JSON.stringify([{ webhook: "default", values: { url, authorization: token } }]),
  });
  if (!r.ok) return r;
  const { httpStatus, body: j } = r.data;
  if (j?.status === 0 || j?.status === "0") return { ok: true, data: { token, url } };
  return { ok: false, definite: true, error: String(j?.msg ?? "http_" + httpStatus).slice(0, 160) };
}

/** Does the Authorization header PayU sent match the token we registered? */
export function payoutWebhookTokenMatches(c: PayuPayoutCreds, header: string | null): boolean {
  if (!c.webhook_token || !header) return false;
  const got = Buffer.from(header.replace(/^Bearer\s+/i, "").trim());
  const want = Buffer.from(c.webhook_token);
  return got.length === want.length && timingSafeEqual(got, want);
}
