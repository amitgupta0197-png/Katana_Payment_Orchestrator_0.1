// POST /api/vendors/poolpay/callback — gateway → orchestrator settlement webhook.
//
// This is the second payment-verification channel (the first is the sender's
// screenshot upload): a payment gateway calls this when the UPI credit lands in the
// receiver / settlement account, which confirms the PoolPay pay-in as paid.
//
// Public route (whitelisted by the VENDOR_CALLBACK matcher in middleware). Auth:
//   • production  — HMAC-SHA256 over (payloadHash + "." + timestamp), ±5min window,
//                   x-timestamp / x-signature headers (same scheme as the generic
//                   /api/vendors/:vendor/callback and BRD §8).
//   • sandbox     — send header `x-sandbox: 1` to skip signing (the cockpit
//                   "Simulate webhook" button uses this).
// Idempotent: a retried webhook delivering the same terminal outcome short-circuits
// to a replay response (final-status lock in confirmPoolPayOrder).

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { payloadHash, verifySignature, vendorSecret } from "@/lib/webhooks";
import { confirmPoolPayOrder } from "@/lib/poolpay-order";

export const dynamic = "force-dynamic";

const schema = z.object({
  order_id: z.string().optional(),          // our order reference
  order_ref: z.string().optional(),         // alias
  status: z.enum(["SUCCESS", "FAILED"]),
  utr: z.string().max(40).optional(),
  rrn: z.string().max(40).optional(),
  settlement_status: z.string().optional(), // e.g. "SETTLED" once credited to settlement a/c
  provider_txn_id: z.string().optional(),
  note: z.string().max(500).optional(),
  raw: z.record(z.unknown()).optional(),
});

export async function POST(req: Request) {
  const sandbox = req.headers.get("x-sandbox") === "1";
  const rawText = await req.text();
  let raw: unknown;
  let body: z.infer<typeof schema>;
  try { raw = JSON.parse(rawText); body = schema.parse(raw); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  if (!sandbox) {
    const ts = req.headers.get("x-timestamp");
    const sig = req.headers.get("x-signature");
    if (!ts || !sig)
      return NextResponse.json({ error: "missing x-timestamp / x-signature headers" }, { status: 401 });
    const check = verifySignature({ secret: vendorSecret("poolpay"), hash: payloadHash(raw), timestamp: ts, signature: sig });
    if (!check.ok)
      return NextResponse.json({ error: "callback rejected", reason: check.reason }, { status: 401 });
  }

  const ref = body.order_id ?? body.order_ref;
  if (!ref) return NextResponse.json({ error: "order_id required" }, { status: 400 });

  try {
    const r = await confirmPoolPayOrder({
      orderRef: ref,
      outcome: body.status,
      utr: body.utr ?? body.rrn ?? null,
      evidence: "WEBHOOK",
      actor: "gateway:poolpay",
      settlementStatus: body.settlement_status ?? null,
      note: body.note ?? `gateway webhook${body.provider_txn_id ? ` (${body.provider_txn_id})` : ""}`,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, idempotent_replay: r.idempotent ?? false, order: r.order });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
