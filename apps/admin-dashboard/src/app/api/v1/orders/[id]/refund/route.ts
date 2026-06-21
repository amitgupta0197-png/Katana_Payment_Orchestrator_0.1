// POST /api/v1/orders/[id]/refund — refund a completed/settled pay-in (BRD §20,
// §27). Body: { amount?, reason? }. Posts a linked refund journal. Finance/Admin.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { toMinor } from "@/lib/money";
import { refundOrder } from "@/lib/fifo";

export const dynamic = "force-dynamic";

const schema = z.object({ amount: z.union([z.number(), z.string()]).optional(), reason: z.string().optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json().catch(() => ({}))); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try {
    const r = await refundOrder({
      orderIdOrRef: id,
      amountMinor: body.amount !== undefined ? toMinor(String(body.amount), "INR") : undefined,
      reason: body.reason, actor: g.session.email,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status ?? 400 });
    return NextResponse.json({ ok: true, status: "REFUND", journal_id: r.journal_id });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
