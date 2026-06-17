// POST /api/vendors/:vendor/callback — provider → orchestrator callback (BRD §8 P4).
//
// Public route. BRD §8 contract enforced:
//   - HMAC-SHA256(secret, payload_hash + "." + timestamp) signature
//   - ±5 minute timestamp tolerance
//   - idempotency_key = vendor + provider_txn_id + event_type
//   - duplicate calls short-circuit to the cached response (no double ledger /
//     no duplicate event_stream entry).
//
// In sandbox the caller can omit signature/timestamp by sending
// header `x-sandbox: 1` so /tmp scripts work without an HMAC step. Real
// provider integrations MUST send both.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { applyTransition, type PaymentState } from "@/lib/payment-states";
import { publish } from "@/lib/events";
import {
  canonicalise, payloadHash, dedupKey, verifySignature, vendorSecret,
} from "@/lib/webhooks";
import { enqueueForOrder } from "@/lib/webhook-outbox";

export const dynamic = "force-dynamic";

const schema = z.object({
  txn_id: z.string().min(1),
  status: z.enum([
    "SUCCESS", "FAILED", "EXPIRED", "AUTHENTICATED", "PROCESSING", "PENDING",
    "REFUNDED", "PARTIALLY_REFUNDED",
  ]),
  provider_txn_id: z.string().optional(),
  raw: z.record(z.unknown()).optional(),
});

const STATUS_TO_EVENT: Record<string, string> = {
  SUCCESS: "payment.success",
  FAILED: "payment.failed",
  REFUNDED: "refund.updated",
  PARTIALLY_REFUNDED: "refund.updated",
};

export async function POST(req: Request, { params }: { params: Promise<{ vendor: string }> }) {
  const { vendor } = await params;
  const sandbox = req.headers.get("x-sandbox") === "1";

  let body: z.infer<typeof schema>;
  let raw: unknown;
  try { raw = await req.json(); body = schema.parse(raw); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  // Signature + replay-window check (skipped only in sandbox mode).
  if (!sandbox) {
    const ts = req.headers.get("x-timestamp");
    const sig = req.headers.get("x-signature");
    if (!ts || !sig)
      return NextResponse.json({ error: "missing x-timestamp / x-signature headers" }, { status: 401 });
    const hash = payloadHash(raw);
    const check = verifySignature({ secret: vendorSecret(vendor), hash, timestamp: ts, signature: sig });
    if (!check.ok)
      return NextResponse.json({ error: "callback rejected", reason: check.reason }, { status: 401 });
  }

  const eventType = STATUS_TO_EVENT[body.status] ?? `payment.${body.status.toLowerCase()}`;
  const providerTxnId = body.provider_txn_id ?? body.txn_id;
  const idempotencyKey = dedupKey(vendor, providerTxnId, eventType);
  const hash = payloadHash(raw);

  try {
    // Idempotent replay — return the cached response if we've already
    // processed this exact (vendor, provider_txn_id, event_type) combo.
    const cached = await rows<any>("checkout",
      "SELECT response_status, response_body, payload_hash FROM callback_dedup WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    if (cached.length) {
      const hashMismatch = cached[0].payload_hash !== hash;
      return NextResponse.json(
        { ...cached[0].response_body, idempotent_replay: true, hash_mismatch: hashMismatch },
        { status: cached[0].response_status, headers: { "x-callback-replay": "1" } },
      );
    }

    const ord = await rows<any>("checkout", `
      SELECT id, status, txn_id, merchant_id, amount_minor::text AS amount_minor, currency
        FROM checkout_orders WHERE txn_id = $1
    `, [body.txn_id]);
    if (!ord.length) {
      await rows("checkout", `
        INSERT INTO webhook_log (event_type, payload, delivered)
        VALUES ($1, $2::jsonb, false)
      `, [`${vendor}.unmatched`, JSON.stringify({ vendor, body })]).catch(() => {});
      return NextResponse.json({ error: "no matching order for txn_id" }, { status: 404 });
    }
    const o = ord[0];
    const from = (o.status as PaymentState);
    const to = body.status as PaymentState;
    const tr = applyTransition(from, to);
    if (!tr.ok) {
      // Still cache illegal-transition rejections so a retry returns the same
      // 409 deterministically.
      await rows("checkout", `
        INSERT INTO callback_dedup
          (vendor, idempotency_key, payload_hash, order_id, from_status, to_status, response_status, response_body)
        VALUES ($1, $2, $3, $4::uuid, $5, $6, 409, $7::jsonb)
        ON CONFLICT (idempotency_key) DO NOTHING
      `, [vendor, idempotencyKey, hash, o.id, from, to,
          JSON.stringify({ error: "illegal transition", from, to, reason: tr.reason })]).catch(() => {});
      await rows("checkout", `
        INSERT INTO webhook_log (order_id, event_type, payload, delivered)
        VALUES ($1::uuid, $2, $3::jsonb, false)
      `, [o.id, `${vendor}.illegal_transition`, JSON.stringify({ from, to, body, reason: tr.reason })]).catch(() => {});
      return NextResponse.json({ error: "illegal transition", from, to, reason: tr.reason }, { status: 409 });
    }

    // Apply and dedup-insert atomically (UNIQUE on idempotency_key wins the
    // race; the loser observes ON CONFLICT and returns the cached path on the
    // next attempt).
    const dedupIns = await rows<any>("checkout", `
      INSERT INTO callback_dedup
        (vendor, idempotency_key, payload_hash, order_id, from_status, to_status, response_status, response_body)
      VALUES ($1, $2, $3, $4::uuid, $5, $6, 200, $7::jsonb)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING dedup_id
    `, [vendor, idempotencyKey, hash, o.id, from, to,
        JSON.stringify({ ok: true, order_id: o.id, from, to })]).catch(() => []);
    if (!dedupIns.length) {
      // Lost the race — re-fetch and return cached.
      const cached2 = (await rows<any>("checkout",
        "SELECT response_status, response_body FROM callback_dedup WHERE idempotency_key=$1",
        [idempotencyKey]))[0];
      return NextResponse.json({ ...cached2.response_body, idempotent_replay: true },
        { status: cached2.response_status, headers: { "x-callback-replay": "race" } });
    }

    await rows("checkout",
      "UPDATE checkout_orders SET status=$1 WHERE id=$2::uuid", [to, o.id]);
    await rows("checkout", `
      INSERT INTO order_state_transitions
        (order_id, from_status, to_status, actor_kind, actor_id, reason, payload)
      VALUES ($1::uuid, $2, $3, 'callback', $4, $5, $6::jsonb)
    `, [o.id, from, to, vendor, `vendor callback ${vendor}`, JSON.stringify(canonicalise(raw))]).catch(() => {});

    await rows("checkout", `
      INSERT INTO webhook_log (order_id, event_type, payload, delivered)
      VALUES ($1::uuid, $2, $3::jsonb, true)
    `, [o.id, `${vendor}.${to.toLowerCase()}`, JSON.stringify(body)]).catch(() => {});

    await publish({
      eventType: "callback.received", producer: "callback_engine",
      entityType: "payment", entityId: o.id, actorId: null,
      payload: { vendor, txn_id: body.txn_id, provider_txn_id: providerTxnId, status: to, idempotency_key: idempotencyKey },
    });

    if (to === "SUCCESS") {
      await publish({
        eventType: "payment.succeeded", producer: "payment_core",
        entityType: "payment", entityId: o.id, actorId: null,
        payload: { txn_id: body.txn_id, amount_minor: o.amount_minor, currency: o.currency, provider: vendor, provider_txn_id: providerTxnId },
      });
      await enqueueForOrder(o.id, "payment.success", {
        txn_id: body.txn_id, amount_minor: o.amount_minor, currency: o.currency,
        provider: vendor, provider_txn_id: providerTxnId, status: to,
      }).catch(() => {});
    } else if (to === "FAILED") {
      await enqueueForOrder(o.id, "payment.failed", {
        txn_id: body.txn_id, amount_minor: o.amount_minor, currency: o.currency,
        provider: vendor, provider_txn_id: providerTxnId, status: to,
      }).catch(() => {});
    }

    return NextResponse.json({ ok: true, order_id: o.id, from, to, idempotency_key: idempotencyKey });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
