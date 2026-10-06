// Outbound merchant webhook outbox (BRD §8 P4).
//
//   enqueue(merchantId, eventType, payload)
//     -> writes to webhook_outbox with status=PENDING and next_attempt_at=now
//   dispatchPending(limit)
//     -> takes up to N due rows, POSTs to target_url with HMAC headers,
//        records the attempt and either marks DELIVERED or schedules the
//        next attempt per BRD retry policy (1m,5m,15m,1h,6h,24h → DLQ).
//
// The dispatch worker is invoked manually from /api/admin/webhooks/dispatch
// for Sprint 3 — Sprint 9 ("Production Hardening") will move it behind a
// proper queue worker.
//
// TWO CONTRACTS SHARE THE OUTBOX (notification 0003). A v1 row is sent as it always was:
// x-event-type / x-timestamp / x-payload-hash, and x-signature when the merchant has a webhook
// config. A v2 row is sent with X-Katana-Event, X-Katana-Signature and X-Katana-Event-ID
// (lib/webhook-v2), signed with the banker's own webhook secret. The version is fixed on the row
// when it is queued, so a merchant who changes version later still gets the retries of an
// earlier event in the form the event was first sent in.

import { rows } from "@/lib/pg";
import { openText } from "@/lib/sealed-text";
import { payloadHash, sign, retrySchedule } from "@/lib/webhooks";
import { publish } from "@/lib/events";
import { safeFetch } from "@/lib/safe-fetch";
import { newEventId, v2SignatureHeader, type WebhookVersion } from "@/lib/webhook-v2";
import { partnerIdFromOutbox } from "@/lib/partner/rules";
import { partnerWebhookSecret } from "@/lib/partner/store";

// NO FALLBACK SECRET. A merchant with no merchant_webhook_configs row used to have its
// callbacks signed with a constant committed to this repo, so anyone could forge a valid
// x-signature for them. Those callbacks are now sent WITHOUT x-signature; the Katana Pay
// status callback's authenticity rests on the HASH in its body, signed with the merchant's
// own checkout salt (lib/merchant-callback.ts), which is unaffected.

export interface OutboxRow {
  outbox_id: string;
  merchant_id: string;
  order_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  target_url: string;
  status: "PENDING" | "DELIVERED" | "DEAD_LETTER" | "TEST_FAILED";
  attempts: number;
  version: WebhookVersion;
  /** v2: the event's id, the same on every retry of this row. */
  event_id: string | null;
  /** A sample event sent from the portal: one attempt, never retried. */
  is_test: boolean;
}

// A database that has not had notification 0003 yet has none of the v2 columns. v1 callbacks
// must keep going out on it, so a read or write that fails on a missing column is made again
// without them.
const missingColumn = (err: unknown) => (err as { code?: string }).code === "42703";
const ROW_COLS = `outbox_id::text, merchant_id, order_id::text, event_type, payload, target_url, status, attempts`;
const V2_COLS = `version, event_id, is_test`;
const V1_DEFAULTS = `'v1' AS version, NULL::text AS event_id, false AS is_test`;

/**
 * The banker's v2 signing secret (merchants.webhook_secret, sealed), or null. A partner's row
 * (merchant_id "partner:<id>", lib/partner) is signed with the partner's own secret.
 */
async function v2Secret(merchantId: string): Promise<string | null> {
  const partnerId = partnerIdFromOutbox(merchantId);
  if (partnerId) return partnerWebhookSecret(partnerId);
  const r = await rows<{ s: string | null }>("merchant",
    `SELECT webhook_secret AS s FROM merchants WHERE merchant_code = $1`, [merchantId]).catch(() => []);
  return openText(r[0]?.s)?.trim() || null;
}

interface ConfigRow { target_url: string; secret: string; enabled: boolean }

async function lookupConfig(merchantId: string): Promise<ConfigRow | null> {
  const r = await rows<ConfigRow>("notification",
    `SELECT target_url, secret, enabled FROM merchant_webhook_configs WHERE merchant_id = $1`,
    [merchantId]).catch(() => []);
  // The signing secret is sealed at rest (lib/sealed-text); rows from before that are plaintext.
  return r[0] ? { ...r[0], secret: openText(r[0].secret) } : null;
}

export async function enqueue(input: {
  merchantId: string; eventType: string; payload: Record<string, unknown>;
  orderId?: string | null; targetUrlOverride?: string;
  livemode?: boolean;   // defaults to live; a test order's callback is recorded as test
  /** v2 rows are delivered with the X-Katana-* headers. Absent = v1. */
  version?: WebhookVersion;
  eventId?: string | null;
  isTest?: boolean;
  resendOf?: string | null;
  requestedBy?: string | null;
}): Promise<string | null> {
  const cfg = await lookupConfig(input.merchantId);
  const target = input.targetUrlOverride ?? cfg?.target_url;
  if (!target) return null;                  // merchant has no webhook configured
  if (cfg && !cfg.enabled) return null;      // explicitly disabled

  const base = [
    input.merchantId, input.orderId ?? null, input.eventType,
    JSON.stringify(input.payload), target, input.livemode !== false,
  ];
  const v2 = input.version === "v2" || input.isTest || input.resendOf;
  if (!v2) {
    const ins = await rows<{ outbox_id: string }>("notification", `
      INSERT INTO webhook_outbox
        (merchant_id, order_id, event_type, payload, target_url, status, next_attempt_at, livemode)
      VALUES ($1, $2, $3, $4::jsonb, $5, 'PENDING', now(), $6)
      RETURNING outbox_id::text
    `, base);
    return ins[0]?.outbox_id ?? null;
  }
  const ins = await rows<{ outbox_id: string }>("notification", `
    INSERT INTO webhook_outbox
      (merchant_id, order_id, event_type, payload, target_url, status, next_attempt_at, livemode,
       version, event_id, is_test, resend_of, requested_by)
    VALUES ($1, $2, $3, $4::jsonb, $5, 'PENDING', now(), $6, $7, $8, $9, $10::uuid, $11)
    RETURNING outbox_id::text
  `, [...base, input.version ?? "v1", input.eventId ?? null, input.isTest === true,
      input.resendOf ?? null, input.requestedBy ?? null]);
  return ins[0]?.outbox_id ?? null;
}

// Convenience wrapper used by callback receiver + POST /api/checkout.
export async function enqueueForOrder(
  orderId: string, eventType: string, payload: Record<string, unknown>,
): Promise<string | null> {
  const o = await rows<{ merchant_id: string }>("checkout",
    `SELECT merchant_id FROM checkout_orders WHERE id = $1::uuid`, [orderId]).catch(() => []);
  if (!o.length) return null;
  return enqueue({ merchantId: o[0].merchant_id, orderId, eventType, payload });
}

function fullUrl(target: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:3100";
  return base.replace(/\/$/, "") + target;
}

export interface DeliveryResult {
  ok: boolean;
  http_status: number | null;
  latency_ms: number;
  error: string | null;
  /** DELIVERED, PENDING (a retry is scheduled), DEAD_LETTER (retries used up) or TEST_FAILED. */
  status: OutboxRow["status"];
}

/** Send one outbox row once, record the attempt, and move the row on. */
async function deliver(row: OutboxRow): Promise<DeliveryResult> {
  const target = row.target_url;
  const attemptNo = row.attempts + 1;
  const ts = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify(row.payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  // A sample event from the portal (lib/webhook-test) says so, so a server can tell it from a real one.
  if (row.is_test) headers["X-Katana-Check"] = "1";
  let signature: string | null = null, err: string | null = null;

  if (row.version === "v2") {
    // A v2 delivery is never sent unsigned: a receiver could not tell it from a forgery.
    const secret = await v2Secret(row.merchant_id);
    if (!secret) err = "no webhook secret: create one under Webhooks in the portal";
    else {
      signature = v2SignatureHeader(secret, ts, rawBody);
      headers["X-Katana-Event"] = row.event_type;
      headers["X-Katana-Signature"] = signature;
      headers["X-Katana-Event-ID"] = row.event_id ?? "";
    }
  } else {
    const cfg = await lookupConfig(row.merchant_id);
    const secret = cfg?.secret?.trim() || null;
    const hash = payloadHash(row.payload);
    signature = secret ? sign(secret, hash, ts) : null;
    headers["x-event-type"] = row.event_type;
    headers["x-timestamp"] = String(ts);
    headers["x-payload-hash"] = hash;
    headers["x-attempt"] = String(attemptNo);
    if (signature) headers["x-signature"] = signature;
  }

  const started = Date.now();
  let status = 0, body = "";
  if (!err) {
    try {
      const r = await safeFetch(fullUrl(target), { method: "POST", headers, body: rawBody });
      status = r.status;
      body = (await r.text()).slice(0, 4_000);
    } catch (e) { err = (e as Error).message; }
  }
  const duration = Date.now() - started;
  const ok = status >= 200 && status < 300;

  await rows("notification", `
    INSERT INTO webhook_dispatch_attempts
      (outbox_id, attempt_no, target_url, request_body, signature, timestamp_sent,
       response_status, response_body, duration_ms, error)
    VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
  `, [row.outbox_id, attemptNo, target, rawBody,
      signature, ts, status || null, body || null, duration, err]).catch(() => {});

  const result = (s: OutboxRow["status"]): DeliveryResult =>
    ({ ok, http_status: status || null, latency_ms: duration, error: ok ? null : err ?? `HTTP ${status}`, status: s });

  if (ok) {
    await rows("notification", `
      UPDATE webhook_outbox
         SET status='DELIVERED', delivered_at=now(), attempts=$1, last_error=NULL
       WHERE outbox_id=$2::uuid
    `, [attemptNo, row.outbox_id]);
    return result("DELIVERED");
  }
  if (row.is_test) {
    // A sample event is shown its result and left at that: no retry, no dead letter, no alert.
    await rows("notification", `
      UPDATE webhook_outbox SET status='TEST_FAILED', attempts=$1, last_error=$2 WHERE outbox_id=$3::uuid
    `, [attemptNo, err ?? `HTTP ${status}`, row.outbox_id]);
    return result("TEST_FAILED");
  }
  // The first attempt, then one after each wait of the schedule (1m, 5m, 15m, 1h, 6h, 24h):
  // seven in all, the last about 31 hours after the first. It used to give up one attempt
  // early, so the 24-hour wait was never used and a merchant whose server was down overnight
  // got its last retry after 7 hours.
  const schedule = retrySchedule();
  if (attemptNo > schedule.length) {
    await rows("notification", `
      UPDATE webhook_outbox
         SET status='DEAD_LETTER', dead_lettered_at=now(),
             attempts=$1, last_error=$2
       WHERE outbox_id=$3::uuid
    `, [attemptNo, err ?? `HTTP ${status}`, row.outbox_id]);
    await publish({
      eventType: "risk.alert", producer: "callback_engine",
      entityType: "webhook", entityId: row.outbox_id, actorId: null,
      payload: { kind: "webhook.dlq", merchant_id: row.merchant_id, event_type: row.event_type, attempts: attemptNo, last_error: err ?? `HTTP ${status}` },
    });
    return result("DEAD_LETTER");
  }
  const wait = schedule[attemptNo - 1];   // attemptNo=1 → schedule[0]
  await rows("notification", `
    UPDATE webhook_outbox
       SET attempts=$1, last_error=$2,
           next_attempt_at = now() + ($3::int * interval '1 second')
     WHERE outbox_id=$4::uuid
  `, [attemptNo, err ?? `HTTP ${status}`, wait, row.outbox_id]);
  return result("PENDING");
}

export async function dispatchPending(opts: { limit?: number } = {}): Promise<{
  picked: number; delivered: number; failed: number; dead_lettered: number;
}> {
  const limit = Math.min(opts.limit ?? 25, 100);
  const due = (cols: string) => rows<OutboxRow>("notification", `
    SELECT ${ROW_COLS}, ${cols}
      FROM webhook_outbox
     WHERE status = 'PENDING' AND next_attempt_at <= now()
     ORDER BY next_attempt_at ASC
     LIMIT ${limit}
     FOR UPDATE SKIP LOCKED
  `);
  const picked = await due(V2_COLS)
    .catch((err) => (missingColumn(err) ? due(V1_DEFAULTS) : Promise.reject(err)))
    .catch(() => [] as OutboxRow[]);

  let delivered = 0, failed = 0, deadLettered = 0;
  for (const row of picked) {
    const r = await deliver(row);
    if (r.status === "DELIVERED") delivered += 1;
    else if (r.status === "DEAD_LETTER") deadLettered += 1;
    else failed += 1;
  }
  return { picked: picked.length, delivered, failed, dead_lettered: deadLettered };
}

async function readRow(outboxId: string): Promise<OutboxRow | null> {
  return (await rows<OutboxRow>("notification",
    `SELECT ${ROW_COLS}, ${V2_COLS} FROM webhook_outbox WHERE outbox_id = $1::uuid`, [outboxId]))[0] ?? null;
}

/** Attempt one queued row now, whatever its schedule says. Null when the row is not waiting. */
export async function deliverNow(outboxId: string): Promise<DeliveryResult | null> {
  const row = await readRow(outboxId);
  return row && row.status === "PENDING" ? deliver(row) : null;
}

/**
 * Queue an identical delivery of an earlier row and attempt it at once.
 *
 * The copy is the same event with the same body, sent to the same address, in the same version.
 * It is a NEW delivery, so a v2 copy carries a new event id (in the header and in the body): a
 * receiver that deduplicates on the id processes it, which is the point of asking for a resend.
 */
export async function resendOutbox(outboxId: string, by: string): Promise<{ outbox_id: string; event_id: string | null; result: DeliveryResult } | null> {
  const src = (await rows<OutboxRow & { livemode: boolean }>("notification",
    `SELECT ${ROW_COLS}, ${V2_COLS}, livemode FROM webhook_outbox WHERE outbox_id = $1::uuid`, [outboxId]))[0];
  if (!src) return null;
  const eventId = src.version === "v2" ? newEventId() : null;
  const payload = eventId ? { ...src.payload, event_id: eventId } : src.payload;
  const ins = await rows<{ outbox_id: string }>("notification", `
    INSERT INTO webhook_outbox
      (merchant_id, order_id, event_type, payload, target_url, status, next_attempt_at, livemode,
       version, event_id, is_test, resend_of, requested_by)
    VALUES ($1, $2::uuid, $3, $4::jsonb, $5, 'PENDING', now(), $6, $7, $8, $9, $10::uuid, $11)
    RETURNING outbox_id::text
  `, [src.merchant_id, src.order_id, src.event_type, JSON.stringify(payload), src.target_url, src.livemode,
      src.version, eventId, src.is_test, src.outbox_id, by]);
  const id = ins[0].outbox_id;
  const result = await deliverNow(id);
  return result ? { outbox_id: id, event_id: eventId, result } : null;
}
