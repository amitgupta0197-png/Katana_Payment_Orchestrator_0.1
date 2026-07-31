// Banker's own advance purchases.
//
//   GET  — read-only list, scoped to the banker's own scope_id.
//   POST — confirm the DT was received (flow change 2026-07-31). This is the
//          FUNDS_SUBMITTED → ACTIVE step that materialises the 60/40 quota + reserve.
//          ADMIN/FINANCE keep the same ability via /api/v1/dt/purchases/{id} as an
//          override, so an unavailable banker cannot deadlock the flow.
//
// Every other lifecycle transition stays admin-side. This route deliberately accepts
// ONE target status: a banker can confirm receipt, not approve, reject or close.
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { rows } from "@/lib/pg";
import { listPurchases, getPurchase, transitionPurchase } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["BANKER"]);
  if ("response" in g) return g.response;
  const bankerId = g.session.scope_id;
  if (!bankerId) return NextResponse.json({ error: "BANKER session missing scope_id" }, { status: 400 });
  const purchases = await listPurchases({ banker_id: bankerId });
  return NextResponse.json({ purchases });
}

const schema = z.object({
  id: z.string().uuid(),
  reference_no: z.string().trim().max(120).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["BANKER"]);
  if ("response" in g) return g.response;
  const bankerId = g.session.scope_id;
  if (!bankerId) return NextResponse.json({ error: "BANKER session missing scope_id" }, { status: 400 });

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  // Ownership check BEFORE the transition — the id comes from the client, so without
  // this a banker could confirm another banker's purchase and activate their lot.
  const own = await rows<{ banker_id: string; status: string }>("provider",
    `SELECT banker_id, status FROM dt_purchases WHERE id = $1::uuid`, [body.id]).catch(() => []);
  if (!own.length) return NextResponse.json({ error: "purchase not found" }, { status: 404 });
  if (own[0].banker_id !== bankerId)
    return NextResponse.json({ error: "that purchase belongs to another banker" }, { status: 403 });
  if (own[0].status !== "FUNDS_SUBMITTED")
    return NextResponse.json({
      error: `only a purchase awaiting your confirmation can be confirmed (this one is ${own[0].status})`,
    }, { status: 409 });

  const r = await transitionPurchase(body.id, "ACTIVE", g.session.email, { reference_no: body.reference_no });
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });

  // Who confirmed receipt, distinct from approved_by (the maker-checker approval).
  await rows("provider", `
    UPDATE dt_purchases SET received_confirmed_by = $2, received_confirmed_at = now()
     WHERE id = $1::uuid
  `, [body.id, g.session.email]).catch(() => {});

  return NextResponse.json({ ok: true, purchase: await getPurchase(body.id) });
}
