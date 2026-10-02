// POST /api/portal/orders/{id}/resend { outbox_id } — queue an identical delivery of one of the
// order's webhooks and attempt it now (lib/webhook-outbox resendOutbox). Same event, same body,
// a new event id.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { PORTAL_PERSONAS, inScope, portalScope } from "@/lib/portal-scope";
import { resendOutbox } from "@/lib/webhook-outbox";
import { orderUuidFrom } from "@/lib/webhook-v2";

export const dynamic = "force-dynamic";

const schema = z.object({ outbox_id: z.string().uuid() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const scope = await portalScope(g.session);
    const orderId = orderUuidFrom((await params).id);
    // The delivery must belong to this order, and the order to a banker the session may act on.
    const row = (await rows<{ merchant_id: string; order_id: string | null }>("notification",
      `SELECT merchant_id, order_id::text FROM webhook_outbox WHERE outbox_id = $1::uuid`, [body.outbox_id]))[0];
    if (!row || !orderId || row.order_id !== orderId || !inScope(scope, row.merchant_id))
      return NextResponse.json({ error: "not found" }, { status: 404 });
    const r = await resendOutbox(body.outbox_id, g.session.email);
    if (!r) return NextResponse.json({ error: "could not resend" }, { status: 409 });
    return NextResponse.json({ ok: true, outbox_id: r.outbox_id, event_id: r.event_id, result: r.result });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
