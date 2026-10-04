// Callback URL checks (merchant 0019). Rules in lib/integration; the screens and the scheduled
// job (/api/v1/cron/callback-verify) call verifyCallback.
//
// A check POSTs a signed test event to the URL, in the banker's own contract, as the portal's
// sample events do (lib/webhook-test): a v2 banker gets a v2 event with its header signature, a
// v1 banker the v1 callback with its HASH (signed with the test Salt when there is one). It is
// a `payment.expired` sample for an order that does not exist (ORDER_ID `integration-check`,
// LIVEMODE false), so a server that acts on it changes nothing. It is sent directly, not through
// the outbox: it is not a callback owed to anyone and is never retried.
//
// The challenge goes in the X-Katana-Challenge header. Any 2xx passes; when the answer is JSON
// with an `echo` field it must equal the challenge.
//
// Every check is a callback_pings row. A per-flow URL's state lives on its banker_callback_urls
// row; the default webhook_url's is worked out from its pings. One failure raises an amber
// alert, three in a row a red one and make the URL FAILED; a pass resolves the alert.
//
// Staff only: alerts go to Katana's admin chats.

import { randomBytes } from "crypto";
import { rows } from "@/lib/pg";
import { openText } from "@/lib/sealed-text";
import { assertPublicUrl } from "@/lib/safe-fetch";
import { getCheckoutCreds } from "@/lib/merchant-checkout";
import { callbackStatus, signKatanaHash } from "@/lib/katana-pay";
import { newEventId, v2SampleBody, v2SignatureHeader, v2StatusOfEvent } from "@/lib/webhook-v2";
import { raiseAlert, resolveAlert } from "@/lib/ops-alert";
import {
  afterCheck, callbackAlertKey, FAIL_AFTER, FLOW_LABEL, pingPasses, stateFromPings,
  type CallbackFlow, type CallbackStatus,
} from "@/lib/integration";

export const PING_TIMEOUT_MS = 10_000;

export interface VerifyInput {
  merchantId: string;
  flow: CallbackFlow | null;
  /** The URL to check; by default the flow's row URL, or the banker's webhook_url for null. */
  url?: string;
  triggeredBy: "MANUAL" | "SCHEDULED";
  actor?: string | null;
}

export interface VerifyResult {
  ok: boolean;
  url: string | null;
  http_status: number | null;
  response_ms: number | null;
  error: string | null;
  status: CallbackStatus | null;
  consecutive_failures: number;
}

/** What actually sends the request. Tests pass their own; it gets the URL already checked as public. */
export type Sender = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ status: number; body: string }>;

const defaultSender: Sender = async (url, init) => {
  await assertPublicUrl(url);   // SSRF-safe: refuses private, loopback and metadata addresses
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, redirect: "error", signal: ctrl.signal });
    return { status: r.status, body: (await r.text()).slice(0, 4_000) };
  } finally { clearTimeout(timer); }
};

interface Banker { id: string; merchant_code: string; webhook_url: string | null; webhook_version: string | null; webhook_secret: string | null }

async function banker(merchantId: string): Promise<Banker | null> {
  const r = await rows<Banker>("merchant", `
    SELECT id::text, merchant_code, webhook_url, webhook_version, webhook_secret FROM merchants WHERE id = $1::uuid`, [merchantId]);
  return r[0] ?? null;
}

/** The signed test event in the banker's contract, or why it cannot be signed. */
async function testEvent(b: Banker, challenge: string): Promise<{ headers: Record<string, string>; body: string } | { error: string }> {
  const headers: Record<string, string> = { "content-type": "application/json", "X-Katana-Challenge": challenge, "X-Katana-Test": "integration-check" };
  const secret = openText(b.webhook_secret);
  if (b.webhook_version === "v2" && secret) {
    const eventId = newEventId();
    const body = JSON.stringify(v2SampleBody("payment.expired", eventId));
    const ts = Math.floor(Date.now() / 1000);
    headers["X-Katana-Event"] = "payment.expired";
    headers["X-Katana-Signature"] = v2SignatureHeader(secret, ts, body);
    headers["X-Katana-Event-ID"] = eventId;
    return { headers, body };
  }
  const creds = (await getCheckoutCreds(b.merchant_code, false).catch(() => null)) ?? (await getCheckoutCreds(b.merchant_code, true).catch(() => null));
  if (!creds?.salt) return { error: "no Key + Salt to sign the test event" };
  const st = callbackStatus(v2StatusOfEvent("payment.expired"));
  const v1: Record<string, string> = {
    PAY_ID: "pay_test", ORDER_ID: "integration-check", TXN_ID: "txn_test", AMOUNT: "100", CURRENCY_CODE: "356",
    STATUS: st.STATUS, RESPONSE_CODE: st.RESPONSE_CODE, RRN: "", RESPONSE_DATE_TIME: new Date().toISOString(), LIVEMODE: "false",
  };
  headers["x-event-type"] = "payin.status";
  return { headers, body: JSON.stringify({ ...v1, HASH: signKatanaHash(v1, creds.salt) }) };
}

export async function appendIntegrationEvent(merchantId: string, event: string, o: { flow?: string | null; detail?: Record<string, unknown>; actor?: string | null } = {}): Promise<void> {
  await rows("merchant", `INSERT INTO integration_events (merchant_id, event, flow, detail, actor) VALUES ($1::uuid, $2, $3, $4::jsonb, $5)`,
    [merchantId, event, o.flow ?? null, JSON.stringify(o.detail ?? {}), o.actor ?? null]);
}

/** Check one callback URL now, record it, move its state on and raise or resolve its alert. */
export async function verifyCallback(input: VerifyInput, send: Sender = defaultSender): Promise<VerifyResult> {
  const b = await banker(input.merchantId);
  if (!b) throw new Error("banker not found");
  const flowRow = input.flow ? (await rows<{ url: string | null; status: CallbackStatus; consecutive_failures: number }>("merchant", `
    SELECT url, status, consecutive_failures FROM banker_callback_urls WHERE merchant_id = $1::uuid AND flow = $2`, [b.id, input.flow]))[0] ?? null : null;
  const url = (input.url ?? (input.flow ? flowRow?.url : b.webhook_url))?.trim() || null;
  if (!url) return { ok: false, url: null, http_status: null, response_ms: null, error: "no callback URL set", status: null, consecutive_failures: 0 };

  const challenge = randomBytes(12).toString("hex");
  const ev = await testEvent(b, challenge);
  let httpStatus: number | null = null, ms: number | null = null, error: string | null = null, ok = false;
  if ("error" in ev) error = ev.error;
  else {
    const started = Date.now();
    try {
      const r = await send(url, { method: "POST", headers: ev.headers, body: ev.body });
      httpStatus = r.status;
      ({ ok, error } = pingPasses(r.status, r.body, challenge));
    } catch (e) {
      const m = (e as Error).name === "AbortError" ? `no answer in ${PING_TIMEOUT_MS / 1000} seconds` : (e as Error).message;
      error = m.slice(0, 300);
    }
    ms = Date.now() - started;
  }

  await rows("merchant", `
    INSERT INTO callback_pings (merchant_id, flow, url, ok, http_status, response_ms, error, challenge, triggered_by, actor)
    VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [b.id, input.flow, url, ok, httpStatus, ms, error, challenge, input.triggeredBy, input.actor ?? null]);

  // The new state. A per-flow row moves only while it still holds the URL that was checked.
  let status: CallbackStatus, failures: number, before: CallbackStatus | null;
  if (input.flow) {
    before = flowRow?.status ?? null;
    const next = afterCheck({ status: flowRow?.status ?? "PENDING", consecutive_failures: flowRow?.consecutive_failures ?? 0 }, ok);
    status = next.status; failures = next.consecutive_failures;
    await rows("merchant", `
      UPDATE banker_callback_urls
         SET status = $3, consecutive_failures = $4, last_checked_at = now(), last_http_status = $5, last_error = $6,
             verified_at = CASE WHEN $7::boolean THEN now() ELSE verified_at END, updated_at = now()
       WHERE merchant_id = $1::uuid AND flow = $2 AND url = $8`,
      [b.id, input.flow, status, failures, httpStatus, error, ok, url]);
  } else {
    const pings = await rows<{ ok: boolean; url: string }>("merchant", `
      SELECT ok, url FROM callback_pings WHERE merchant_id = $1::uuid AND flow IS NULL ORDER BY id DESC LIMIT 20`, [b.id]);
    const s = stateFromPings(pings, url);
    const prev = stateFromPings(pings.slice(1), url);
    before = prev.checked ? prev.status : null;
    status = s.status; failures = s.consecutive_failures;
  }

  // Alerts: one per banker and flow; amber at the first failure, red at the third, resolved by a pass.
  const key = callbackAlertKey(b.merchant_code, input.flow);
  const where = input.flow ? `${FLOW_LABEL[input.flow]} callback URL` : "callback URL";
  if (ok) await resolveAlert(key, `${b.merchant_code}: the ${where} answers again`);
  else await raiseAlert({
    key, severity: failures >= FAIL_AFTER ? "CRITICAL" : "WARN", repeatMinutes: 360,
    title: `Banker ${b.merchant_code}: ${where} ${failures >= FAIL_AFTER ? `failed ${failures} checks in a row` : "failed a check"}`,
    body: `${url}\n${error ?? "no answer"}`,
  });

  // The log: every failure and every manual pass; a scheduled pass only when it changes something.
  if (!ok || input.triggeredBy === "MANUAL" || before !== "VERIFIED")
    await appendIntegrationEvent(b.id, ok ? "callback_verified" : "callback_failed", {
      flow: input.flow, actor: input.actor ?? (input.triggeredBy === "SCHEDULED" ? "scheduled check" : null),
      detail: { url, http_status: httpStatus, response_ms: ms, error, status, consecutive_failures: failures, triggered_by: input.triggeredBy },
    }).catch(() => {});

  return { ok, url, http_status: httpStatus, response_ms: ms, error, status, consecutive_failures: failures };
}

export interface DueCheck { merchant_id: string; flow: CallbackFlow | null }

/**
 * The URLs the scheduled job checks: per-flow rows with a URL, and the webhook_url of every LIVE
 * banker, not checked for `hours`; the longest unchecked first.
 */
export async function dueChecks(hours: number, limit: number): Promise<DueCheck[]> {
  return rows<DueCheck>("merchant", `
    SELECT merchant_id, flow FROM (
      SELECT b.merchant_id::text AS merchant_id, b.flow, b.last_checked_at AS checked
        FROM banker_callback_urls b
       WHERE b.url IS NOT NULL AND (b.last_checked_at IS NULL OR b.last_checked_at < now() - make_interval(hours => $1::int))
      UNION ALL
      SELECT m.id::text, NULL::text, p.at
        FROM merchants m
        LEFT JOIN LATERAL (SELECT at FROM callback_pings c WHERE c.merchant_id = m.id AND c.flow IS NULL AND c.url = btrim(m.webhook_url) ORDER BY c.id DESC LIMIT 1) p ON true
       WHERE m.stage = 'LIVE' AND m.webhook_url ~* '^\\s*https?://'
         AND (p.at IS NULL OR p.at < now() - make_interval(hours => $1::int))
    ) d ORDER BY checked NULLS FIRST LIMIT $2`, [hours, limit]);
}
