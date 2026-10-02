// Sample webhook events (lib/webhook-test).
//   POST /api/portal/webhooks/test { merchant_code, event }   send one to the banker's callback URL
//   GET  /api/portal/webhooks/test?merchant_code=…            the last samples sent and their results
// A sample belongs to no order and changes none.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { PORTAL_PERSONAS, inScope, portalScope } from "@/lib/portal-scope";
import { sendTestEvent } from "@/lib/webhook-test";
import { readDeliveries } from "@/lib/order-timeline";

export const dynamic = "force-dynamic";

const schema = z.object({
  merchant_code: z.string().min(1).max(120),
  event: z.enum(["payment.success", "payment.failed", "payment.expired"]),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    if (!inScope(await portalScope(g.session), body.merchant_code)) return NextResponse.json({ error: "not found" }, { status: 404 });
    const r = await sendTestEvent(body.merchant_code, body.event, g.session.email);
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function GET(req: Request) {
  const g = await gateOrResponse(PORTAL_PERSONAS);
  if ("response" in g) return g.response;
  const code = new URL(req.url).searchParams.get("merchant_code") ?? "";
  try {
    const scope = await portalScope(g.session);
    if (!inScope(scope, code)) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ tests: await readDeliveries("merchant_id = $1 AND is_test", [code], scope.staff, 10) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
