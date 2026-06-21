// POST /api/v1/webhooks/payment-status — inbound gateway/provider status callback
// (BRD §19). Unauthenticated but HMAC-SHA256 signature-verified (x-signature over
// the raw body). Records the callback on the order's timeline and captures the UTR.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { signPayload } from "@/lib/fifo-notify";
import { recordEvent } from "@/lib/fifo";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get("x-signature") ?? "";
  if (!sig || signPayload(raw) !== sig) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  let body: any;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const ref = body.order_id ?? body.order_ref ?? body.transaction_id ?? body.txn_ref;
  if (!ref) return NextResponse.json({ error: "order_id/transaction_id required" }, { status: 400 });

  try {
    const o = (await rows<any>("fifo", `
      SELECT id::text, status FROM fifo_orders
       WHERE order_ref=$1 OR txn_ref=$1 OR id::text=$1 LIMIT 1
    `, [ref]))[0];
    if (!o) return NextResponse.json({ error: "order not found" }, { status: 404 });

    if (body.utr) await rows("fifo", `UPDATE fifo_orders SET utr=COALESCE(utr,$2) WHERE id=$1::uuid`, [o.id, body.utr]).catch(() => {});
    await recordEvent({
      orderId: o.id, from: o.status, to: o.status, actorKind: "gateway",
      reason: `gateway callback: ${body.status ?? "status"}`,
      payload: { gateway_status: body.status ?? null, utr: body.utr ?? null, settlement_status: body.settlement_status ?? null },
    });
    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
