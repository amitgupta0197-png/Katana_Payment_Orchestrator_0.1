// POST /api/v1/katana-pay/callback/[slug] — a merchant's own TSP webhook link.
//
// The payment gateway / TSP a merchant was onboarded with posts that merchant's payment
// results here. Same body and signing contract as /api/v1/katana-pay/callback, but:
//   - the signature is verified with THIS merchant's secret (credential vault), and
//   - an order is confirmed only if it belongs to THIS merchant. Order refs are unique per
//     merchant, not platform-wide (migration 0024), so the order is resolved to its uuid
//     inside the merchant before confirming — a TSP holding merchant A's link can never
//     touch merchant B's order, even one with the same ref.
// No sandbox bypass: a real per-merchant link always requires a valid signature.
// Public: allow-listed in middleware PUBLIC_API_PREFIX.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { payloadHash, verifySignature } from "@/lib/webhooks";
import { confirmPoolPayOrder } from "@/lib/poolpay-order";
import { merchantByWebhookSlug, readWebhookSecret } from "@/lib/merchant-webhook";

export const dynamic = "force-dynamic";

const schema = z.object({
  order_id: z.string().optional(),          // the merchant's order reference
  order_ref: z.string().optional(),         // alias
  status: z.enum(["SUCCESS", "FAILED"]),
  utr: z.string().max(40).optional(),
  rrn: z.string().max(40).optional(),
  settlement_status: z.string().optional(),
  provider_txn_id: z.string().optional(),
  note: z.string().max(500).optional(),
  raw: z.record(z.unknown()).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const merchant = await merchantByWebhookSlug(slug);
  if (!merchant) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rawText = await req.text();
  let raw: unknown;
  let body: z.infer<typeof schema>;
  try { raw = JSON.parse(rawText); body = schema.parse(raw); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  const ts = req.headers.get("x-timestamp");
  const sig = req.headers.get("x-signature");
  if (!ts || !sig)
    return NextResponse.json({ error: "missing x-timestamp / x-signature headers" }, { status: 401 });
  // ONE LINK, TWO SECRETS. The live secret is tried first, then the test secret; the one that
  // verifies decides the callback's mode, and only an order of that mode can be confirmed below.
  // An unissued secret is reported exactly like a bad signature, so the link does not reveal
  // which merchants have finished setting up.
  let livemode: boolean | null = null;
  let reason = "signature mismatch";
  for (const mode of [true, false]) {
    const secret = await readWebhookSecret(merchant.merchant_code, mode).catch(() => null);
    if (!secret) continue;
    const check = verifySignature({ secret, hash: payloadHash(raw), timestamp: ts, signature: sig });
    if (check.ok) { livemode = mode; break; }
    if (check.reason !== "signature mismatch") reason = check.reason;
  }
  if (livemode === null) return NextResponse.json({ error: "callback rejected", reason }, { status: 401 });

  const ref = body.order_id ?? body.order_ref;
  if (!ref) return NextResponse.json({ error: "order_id required" }, { status: 400 });

  try {
    const own = await rows<{ id: string }>("vendorGateway", `
      SELECT id::text FROM vendor_payin_orders
       WHERE vendor = 'POOLPAY' AND merchant_id = $1 AND order_id = $2 AND livemode = $3
         AND COALESCE(meta->'gateway'->>'provider', '') = ''   -- gateway orders (PayU, Razorpay, …) are confirmed by their gateway only
    `, [merchant.merchant_code, ref, livemode]);
    if (!own.length) return NextResponse.json({ error: "not found" }, { status: 404 });

    const r = await confirmPoolPayOrder({
      id: own[0].id,
      livemode,                 // the mode the verifying secret proved
      outcome: body.status,
      utr: body.utr ?? body.rrn ?? null,
      evidence: "WEBHOOK",
      actor: `gateway:tsp:${merchant.merchant_code}${livemode ? "" : ":test"}`,
      settlementStatus: body.settlement_status ?? null,
      note: body.note ?? `TSP webhook${body.provider_txn_id ? ` (${body.provider_txn_id})` : ""}`,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, idempotent_replay: r.idempotent ?? false, order: r.order });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
