// POST /api/v1/dt/purchases/{id}/merchant — assign (or clear) the merchant whose incoming
// pay-ins repay this purchase lot. body { payin_merchant_code: string | null }.
//
// This is the switch that turns a DT lot from inert into something real money consumes:
// once assigned, every CONFIRMED pay-in landing on any banker under that merchant draws
// down this lot (FIFO across the merchant's lots) — see lib/dt-payin.ts.
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { getPurchase } from "@/lib/dt";
import { assignPayinMerchant } from "@/lib/dt-payin";

export const dynamic = "force-dynamic";

const schema = z.object({
  payin_merchant_code: z.string().trim().max(120).nullable(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
  if ("response" in g) return g.response;
  const { id } = await params;

  let body;
  try { body = schema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  const r = await assignPayinMerchant(id, body.payin_merchant_code || null, g.session.email);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, purchase: await getPurchase(id) });
}
