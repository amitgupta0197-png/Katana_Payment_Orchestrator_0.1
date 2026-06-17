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

import { rows } from "@/lib/pg";
import { payloadHash, sign, retrySchedule } from "@/lib/webhooks";
import { publish } from "@/lib/events";

const DEFAULT_SECRET = "sandbox-merchant-secret-do-not-use-in-prod";

export interface OutboxRow {
  outbox_id: string;
  merchant_id: string;
  order_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  target_url: string;
  status: "PENDING" | "DELIVERED" | "DEAD_LETTER";
  attempts: number;
}

interface ConfigRow { target_url: string; secret: string; enabled: boolean }

async function lookupConfig(merchantId: string): Promise<ConfigRow | null> {
  const r = await rows<ConfigRow>("notification",
    `SELECT target_url, secret, enabled FROM merchant_webhook_configs WHERE merchant_id = $1`,
    [merchantId]).catch(() => []);
  return r[0] ?? null;
}

export async function enqueue(input: {
  merchantId: string; eventType: string; payload: Record<string, unknown>;
  orderId?: string | null; targetUrlOverride?: string;
}): Promise<string | null> {
  const cfg = await lookupConfig(input.merchantId);
  const target = input.targetUrlOverride ?? cfg?.target_url;
  if (!target) return null;                  // merchant has no webhook configured
  if (cfg && !cfg.enabled) return null;      // explicitly disabled

  const ins = await rows<{ outbox_id: string }>("notification", `
    INSERT INTO webhook_outbox
      (merchant_id, order_id, event_type, payload, target_url, status, next_attempt_at)
    VALUES ($1, $2, $3, $4::jsonb, $5, 'PENDING', now())
    RETURNING outbox_id::text
  `, [
    input.merchantId, input.orderId ?? null, input.eventType,
    JSON.stringify(input.payload), target,
  ]);
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

export async function dispatchPending(opts: { limit?: number } = {}): Promise<{
  picked: number; delivered: number; failed: number; dead_lettered: number;
}> {
  const limit = Math.min(opts.limit ?? 25, 100);
  const due = await rows<OutboxRow>("notification", `
    SELECT outbox_id::text, merchant_id, order_id::text, event_type, payload,
           target_url, status, attempts
      FROM webhook_outbox
     WHERE status = 'PENDING' AND next_attempt_at <= now()
     ORDER BY next_attempt_at ASC
     LIMIT ${limit}
     FOR UPDATE SKIP LOCKED
  `).catch(() => []);

  let delivered = 0, failed = 0, deadLettered = 0;
  for (const row of due) {
    const cfg = await lookupConfig(row.merchant_id);
    const secret = cfg?.secret ?? DEFAULT_SECRET;
    const target = row.target_url;
    const attemptNo = row.attempts + 1;
    const hash = payloadHash(row.payload);
    const ts = Math.floor(Date.now() / 1000);
    const signature = sign(secret, hash, ts);

    const started = Date.now();
    let status = 0, body = "", err: string | null = null;
    try {
      const r = await fetch(fullUrl(target), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-event-type": row.event_type,
          "x-timestamp": String(ts),
          "x-signature": signature,
          "x-payload-hash": hash,
          "x-attempt": String(attemptNo),
        },
        body: JSON.stringify(row.payload),
        signal: AbortSignal.timeout(5_000),
      });
      status = r.status;
      body = (await r.text()).slice(0, 4_000);
    } catch (e) { err = (e as Error).message; }
    const duration = Date.now() - started;
    const ok = status >= 200 && status < 300;

    await rows("notification", `
      INSERT INTO webhook_dispatch_attempts
        (outbox_id, attempt_no, target_url, request_body, signature, timestamp_sent,
         response_status, response_body, duration_ms, error)
      VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
    `, [row.outbox_id, attemptNo, target, JSON.stringify(row.payload),
        signature, ts, status || null, body || null, duration, err]).catch(() => {});

    if (ok) {
      await rows("notification", `
        UPDATE webhook_outbox
           SET status='DELIVERED', delivered_at=now(), attempts=$1, last_error=NULL
         WHERE outbox_id=$2::uuid
      `, [attemptNo, row.outbox_id]);
      delivered += 1;
    } else {
      const schedule = retrySchedule();
      if (attemptNo >= schedule.length) {
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
        deadLettered += 1;
      } else {
        const wait = schedule[attemptNo - 1];   // attemptNo=1 → schedule[0]
        await rows("notification", `
          UPDATE webhook_outbox
             SET attempts=$1, last_error=$2,
                 next_attempt_at = now() + ($3::int * interval '1 second')
           WHERE outbox_id=$4::uuid
        `, [attemptNo, err ?? `HTTP ${status}`, wait, row.outbox_id]);
        failed += 1;
      }
    }
  }
  return { picked: due.length, delivered, failed, dead_lettered: deadLettered };
}
