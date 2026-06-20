// POST /api/settlement/trigger — run a settlement cycle (SUPER_ADMIN).
//
//   1. Release any due reserve holds (freed funds become payable for the NEXT cycle).
//   2. Find every merchant with payment/reserve activity in the period.
//   3. Create a settlement batch per merchant (computeTotals nets out prior settlements).
//   4. Optionally auto-disburse each batch's payout (simulated bank transfer + UTR).
//
// Defaults to a T+1 window (last 24h) when no period is given.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { createBatch } from "@/lib/settlement";
import { processPayout } from "@/lib/payout";
import { releaseDueReserves } from "@/lib/reserves";
import { publish } from "@/lib/events";

export const dynamic = "force-dynamic";

const schema = z.object({
  period_start:     z.string().optional(),
  period_end:       z.string().optional(),
  currency:         z.string().default("INR"),
  release_reserves: z.boolean().default(true),
  auto_payout:      z.boolean().default(true),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = schema.parse(await req.json().catch(() => ({}))); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const periodEnd = body.period_end ? new Date(body.period_end) : new Date();
  const periodStart = body.period_start ? new Date(body.period_start) : new Date(periodEnd.getTime() - 24 * 3600 * 1000);
  const currency = body.currency.toUpperCase();

  try {
    // 1. Release due reserve holds first.
    const reserves = body.release_reserves ? await releaseDueReserves() : { released: 0, total_minor: "0" };

    // 2. Merchants with settle-relevant activity in the period.
    const merchants = await rows<{ merchant_id: string }>("ledger", `
      SELECT DISTINCT merchant_id FROM journal_entries
       WHERE tenant_id='tenant-default' AND currency=$1
         AND posted_at >= $2 AND posted_at < $3
         AND journal_type IN ('payment.success','reserve.release')
         AND merchant_id IS NOT NULL
    `, [currency, periodStart.toISOString(), periodEnd.toISOString()]).catch(() => []);

    // 3 + 4. Settle (and optionally disburse) each merchant.
    const batches: Array<Record<string, unknown>> = [];
    let totalNet = 0n;
    let paid = 0;
    for (const m of merchants) {
      const b = await createBatch({
        merchantId: m.merchant_id, periodStart, periodEnd, currency, actorEmail: s.email,
      });
      let payout: { utr?: string; status: string } | null = null;
      if (body.auto_payout && b.payout_id) {
        const pr = await processPayout(b.payout_id);
        if (pr.ok) { payout = { utr: pr.utr, status: pr.status }; paid += 1; }
      }
      totalNet += b.totals.net_minor;
      batches.push({
        merchant_id: m.merchant_id, batch_id: b.batch_id, status: payout ? "PAID" : b.status,
        net_minor: b.totals.net_minor.toString(), payout,
      });
    }

    await publish({
      eventType: "settlement.calculated", producer: "settlement_engine",
      entityType: "settlement", entityId: `run:${periodStart.toISOString()}`, actorId: s.user_id,
      payload: { kind: "settlement.run", merchants: merchants.length, batches_paid: paid, reserves_released: reserves.released, currency },
    });

    return NextResponse.json({
      period: { start: periodStart.toISOString(), end: periodEnd.toISOString(), currency },
      reserves_released: reserves.released,
      reserves_total_minor: reserves.total_minor,
      merchants: merchants.length,
      batches_paid: paid,
      total_net_minor: totalNet.toString(),
      batches,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
