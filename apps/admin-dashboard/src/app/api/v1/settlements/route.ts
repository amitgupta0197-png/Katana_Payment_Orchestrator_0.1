// POST /api/v1/settlements — create a settlement batch for a merchant (BRD §19,
//   §22). Nets completed-but-unsettled pay-ins; large/adjusted batches → approval.
// GET  /api/v1/settlements — list batches.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { toMinor } from "@/lib/money";
import { createSettlementBatch } from "@/lib/fifo-settlement";

export const dynamic = "force-dynamic";

const schema = z.object({
  merchant_id: z.string().min(1),
  currency: z.string().default("INR"),
  chargeback_hold: z.union([z.number(), z.string()]).optional(),
  adjustment: z.union([z.number(), z.string()]).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const currency = body.currency.toUpperCase();
  try {
    const r = await createSettlementBatch({
      merchantId: body.merchant_id, currency,
      chargebackHoldMinor: body.chargeback_hold !== undefined ? toMinor(String(body.chargeback_hold), currency) : 0n,
      adjustmentMinor: body.adjustment !== undefined ? toMinor(String(body.adjustment), currency) : 0n,
      createdBy: g.session.email,
    });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status ?? 400 });
    return NextResponse.json({ batch: r.batch }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "COMPLIANCE"]);
  if ("response" in g) return g.response;
  try {
    const batches = await rows<any>("fifo", `
      SELECT id::text, batch_ref, merchant_id, currency, order_count,
             gross_minor::text, mdr_minor::text, reserve_minor::text, gst_minor::text,
             chargeback_hold_minor::text, adjustment_minor::text, net_minor::text,
             status, journal_id, created_by, created_at, settled_at
        FROM fifo_settlement_batches ORDER BY created_at DESC LIMIT 200
    `);
    return NextResponse.json({ batches });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
