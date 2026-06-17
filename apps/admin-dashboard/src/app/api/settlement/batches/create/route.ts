// POST /api/settlement/batches/create — compute & persist a settlement batch
// for a merchant + period.
//
// Body: { merchant_id, period_start, period_end, currency }
// Returns the totals (debit==credit invariant guaranteed by lib/ledger).

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { createBatch } from "@/lib/settlement";
import { publish } from "@/lib/events";

export const dynamic = "force-dynamic";

const schema = z.object({
  merchant_id:  z.string().min(1),
  period_start: z.string(),
  period_end:   z.string(),
  currency:     z.string().default("INR"),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const result = await createBatch({
      merchantId: body.merchant_id,
      periodStart: new Date(body.period_start),
      periodEnd: new Date(body.period_end),
      currency: body.currency, actorEmail: s.email,
    });
    await publish({
      eventType: "settlement.calculated", producer: "settlement_engine",
      entityType: "settlement", entityId: result.batch_id, actorId: s.user_id,
      payload: {
        merchant_id: body.merchant_id,
        gross_minor: result.totals.gross_minor.toString(),
        net_minor: result.totals.net_minor.toString(),
        currency: body.currency,
      },
    });
    return NextResponse.json({
      ...result,
      totals: {
        gross_minor: result.totals.gross_minor.toString(),
        fees_minor: result.totals.fees_minor.toString(),
        commissions_minor: result.totals.commissions_minor.toString(),
        reserves_minor: result.totals.reserves_minor.toString(),
        net_minor: result.totals.net_minor.toString(),
        payment_count: result.totals.payment_count,
      },
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
