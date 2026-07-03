// Operations confirmation / reconciliation for a PoolPay pay-in.
//
// In production, merchants create the order; the cockpit lists pending orders and
// the operations team confirms each one — by recording the UTR/RRN obtained via
// scraping, a customer payment screenshot, or a bank/gateway webhook — and marks
// the result SUCCESS or FAILED. This endpoint is that manual/assisted path; the
// fully-automated path is the existing /api/vendors/poolpay/callback webhook.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { confirmPoolPayOrder } from "@/lib/poolpay-order";

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
    const r = await confirmPoolPayOrder({
      id, outcome: body.outcome, utr: body.utr ?? null, note: body.note ?? null,
      evidence: body.evidence, actor: s.email,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, order: r.order });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
