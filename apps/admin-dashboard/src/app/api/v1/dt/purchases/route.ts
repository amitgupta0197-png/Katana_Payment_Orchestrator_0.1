// GET /api/v1/dt/purchases — list DT purchases (filter by banker/status).
// POST — create a DRAFT purchase (advance debit = quantity × buy_rate). BRD §10.
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { listPurchases, createPurchase, currentRate } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  const sp = new URL(req.url).searchParams;
  return NextResponse.json({
    purchases: await listPurchases({ banker_id: sp.get("banker") || undefined, status: sp.get("status") || undefined }),
  });
}

const schema = z.object({
  banker_id: z.string().trim().min(1).max(120),
  quantity: z.number().positive(),
  buy_rate: z.number().positive().optional(),   // defaults to current rate card
  priority_percent: z.number().min(0).max(100).optional(),
  security_percent: z.number().min(0).max(100).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
  if ("response" in g) return g.response;
  let body; try { body = schema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  let rate = body.buy_rate;
  if (!rate) { const rc = await currentRate(); if (!rc) return NextResponse.json({ error: "no active DT rate card — set a rate first" }, { status: 400 }); rate = rc.rate; }
  if ((body.priority_percent ?? 60) + (body.security_percent ?? 40) !== 100)
    return NextResponse.json({ error: "priority % + security % must equal 100" }, { status: 400 });

  const purchase = await createPurchase({ ...body, buy_rate: rate }, g.session.email);
  return NextResponse.json({ ok: true, purchase });
}
