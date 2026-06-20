// POST /api/settlement/batches/[id]/payout — disburse a batch's payout
// (SUPER_ADMIN). Simulated bank transfer; stamps a UTR and flips the batch to PAID.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { payoutForBatch, processPayout } from "@/lib/payout";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const payoutId = await payoutForBatch(id);
    if (!payoutId) return NextResponse.json({ error: "no payout for this batch (nothing to disburse)" }, { status: 404 });
    const pr = await processPayout(payoutId);
    if (!pr.ok) return NextResponse.json({ error: `payout ${pr.status}` }, { status: 409 });
    return NextResponse.json({ ok: true, status: pr.status, utr: pr.utr });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
