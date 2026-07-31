// GET  /api/v1/dt/purchases/{id} — one purchase.
// POST /api/v1/dt/purchases/{id} — advance the lifecycle (BRD §10 status machine).
//   body { to, reference_no?, amount? }. Covers submit (→PENDING_APPROVAL),
//   approve (→AWAITING_FUNDS), banker funds (→FUNDS_SUBMITTED), confirm-funds
//   (→ACTIVE, materialises 60/40 quota+reserve), reject/close.
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { getPurchase, transitionPurchase, auditDt } from "@/lib/dt";
import { rows } from "@/lib/pg";

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
  // Katana assigns the banker; the merchant never chooses one. Supplied when approving
  // a merchant-raised request that has no banker yet.
  banker_id: z.string().trim().min(1).max(120).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body; try { body = schema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  if (body.banker_id) {
    await rows("provider", `
      UPDATE dt_purchases
         SET banker_id = $2, banker_assigned_by = $3, banker_assigned_at = now(), updated_at = now()
       WHERE id = $1::uuid
    `, [id, body.banker_id, g.session.email]).catch(() => {});
    await auditDt(g.session.email, "BANKER_ASSIGNED", "dt_purchase", id, null, { banker_id: body.banker_id });
  }

  // A merchant-raised request carries no banker. It must not advance past approval
  // unassigned — every downstream step (funding, USDT acceptance, quota, reserve) is
  // keyed to a banker, so an unassigned lot would have nowhere to land.
  if (body.to !== "REJECTED" && body.to !== "PENDING_APPROVAL") {
    const cur = await rows<{ banker_id: string | null }>("provider",
      `SELECT banker_id FROM dt_purchases WHERE id = $1::uuid`, [id]).catch(() => []);
    if (cur.length && !cur[0].banker_id)
      return NextResponse.json({ error: "assign a banker before advancing this request" }, { status: 409 });
  }

  const r = await transitionPurchase(id, body.to, g.session.email, { reference_no: body.reference_no, amount: body.amount });
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, purchase: await getPurchase(id) });
}
