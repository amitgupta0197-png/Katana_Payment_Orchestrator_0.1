// DT settlement reconciliation — the ONLY thing that reduces the outstanding
// settlement buffer (product decision 2026-07-16). No risk/chargeback logic:
//   Outstanding Buffer = Total 40% funded − Settlement released
//
// GET  /api/v1/dt/settlements?banker=X — buffer ledger (cycle rows).
// POST /api/v1/dt/settlements — record verified settled traffic for a banker:
//   releases that amount from lot reserves FIFO (oldest first, partial supported)
//   and appends a ledger row. Over-settling beyond the outstanding buffer is refused.
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { rows } from "@/lib/pg";
import { auditDt, addBufferEntry, bufferLedger, reserveRemaining } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  const banker = new URL(req.url).searchParams.get("banker") || undefined;
  return NextResponse.json({ entries: await bufferLedger(banker) });
}

const schema = z.object({
  banker_id: z.string().trim().min(1).max(120),
  amount: z.number().positive(),
  reference: z.string().trim().max(200).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const amount = +body.amount.toFixed(2);
  const outstanding = await reserveRemaining(body.banker_id);
  if (amount > outstanding + 0.005)
    return NextResponse.json({
      error: `settlement ${amount} exceeds the outstanding buffer ${outstanding} for ${body.banker_id}`,
    }, { status: 409 });

  // FIFO release: oldest lot's remaining reserve first, partials allowed.
  const reserves = await rows<{ id: string; remaining: number }>("provider", `
    SELECT s.id::text, GREATEST(s.held - s.released, 0)::float AS remaining
      FROM security_reserves s JOIN dt_purchases p ON p.id = s.purchase_id
     WHERE p.banker_id = $1 AND s.held - s.released > 0
     ORDER BY s.created_at ASC
  `, [body.banker_id]);
  let left = amount;
  const releases: { reserve_id: string; amount: number }[] = [];
  for (const r of reserves) {
    if (left <= 0) break;
    const take = +Math.min(r.remaining, left).toFixed(2);
    await rows("provider", `
      UPDATE security_reserves
         SET released = released + $2,
             status = CASE WHEN released + $2 >= held THEN 'RELEASED' ELSE 'PARTIALLY_RELEASED' END,
             updated_at = now()
       WHERE id = $1::uuid
    `, [r.id, take]);
    releases.push({ reserve_id: r.id, amount: take });
    left = +(left - take).toFixed(2);
  }

  const buf = await addBufferEntry(body.banker_id, {
    released: amount, refSettlement: body.reference, note: "settlement reconciliation", actor: g.session.email,
  });
  await auditDt(g.session.email, "SETTLEMENT_RELEASE", "settlement_buffer", body.banker_id,
    { outstanding_before: outstanding }, { amount, reference: body.reference ?? null, releases, outstanding_after: buf.closing });
  return NextResponse.json({ ok: true, released: amount, outstanding_buffer: buf.closing, lots_touched: releases.length });
}
