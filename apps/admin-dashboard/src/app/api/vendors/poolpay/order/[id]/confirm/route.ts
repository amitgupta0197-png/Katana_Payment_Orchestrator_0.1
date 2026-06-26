// Operations confirmation / reconciliation for a PoolPay pay-in.
//
// In production, merchants create the order; the cockpit lists pending orders and
// the operations team confirms each one — by recording the UTR/RRN obtained via
// scraping, a customer payment screenshot, or a bank/gateway webhook — and marks
// the result SUCCESS or FAILED. This endpoint is that manual/assisted path; the
// fully-automated path is the existing /api/vendors/poolpay/callback webhook.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { genRrn, POOLPAY_TERMINAL } from "@/lib/poolpay";

export const dynamic = "force-dynamic";

const schema = z.object({
  outcome: z.enum(["SUCCESS", "FAILED"]),
  utr: z.string().max(40).optional(),       // UTR / RRN from bank / scrape / screenshot
  note: z.string().max(500).optional(),     // e.g. "screenshot verified", source ref
  evidence: z.enum(["UTR", "SCREENSHOT", "WEBHOOK", "MANUAL"]).default("MANUAL"),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const cur = await rows<any>("vendorGateway",
      `SELECT id::text, order_id, status, meta FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'POOLPAY'`, [id]);
    if (!cur.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    const order = cur[0];
    if (POOLPAY_TERMINAL.has(order.status))
      return NextResponse.json({ error: `order already ${order.status}` }, { status: 409 });

    const rrn = body.outcome === "SUCCESS" ? (body.utr?.trim() || genRrn(order.id)) : null;
    const responseCode = body.outcome === "SUCCESS" ? "00" : "U30";
    const meta = {
      ...(order.meta ?? {}),
      confirmation: {
        by: s.email,
        at: new Date().toISOString(),
        evidence: body.evidence,
        utr: body.utr ?? null,
        note: body.note ?? null,
      },
    };
    const upd = await rows<any>("vendorGateway", `
      UPDATE vendor_payin_orders
         SET status = $2, response_code = $3, rrn = COALESCE($4, rrn), meta = $5::jsonb, updated_at = now()
       WHERE id = $1::uuid
      RETURNING id::text, order_id, status, COALESCE(rrn,'') AS rrn
    `, [id, body.outcome, responseCode, rrn, JSON.stringify(meta)]);

    return NextResponse.json({ ok: true, order: upd[0] });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
