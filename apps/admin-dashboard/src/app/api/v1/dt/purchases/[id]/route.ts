// GET  /api/v1/dt/purchases/{id} — one purchase.
// POST /api/v1/dt/purchases/{id} — advance the lifecycle (BRD §10 status machine).
//   body { to, reference_no?, amount? }. Covers submit (→PENDING_APPROVAL),
//   approve (→AWAITING_FUNDS), banker funds (→FUNDS_SUBMITTED), confirm-funds
//   (→ACTIVE, materialises 60/40 quota+reserve), reject/close.
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { getPurchase, transitionPurchase } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const p = await getPurchase(id);
  return p ? NextResponse.json({ purchase: p }) : NextResponse.json({ error: "not found" }, { status: 404 });
}

const schema = z.object({
  to: z.enum(["PENDING_APPROVAL", "AWAITING_FUNDS", "FUNDS_SUBMITTED", "ACTIVE", "EXHAUSTED", "SUSPENDED", "REFILLED", "CLOSED", "REJECTED"]),
  reference_no: z.string().trim().max(120).optional(),
  amount: z.number().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body; try { body = schema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const r = await transitionPurchase(id, body.to, g.session.email, { reference_no: body.reference_no, amount: body.amount });
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, purchase: await getPurchase(id) });
}
