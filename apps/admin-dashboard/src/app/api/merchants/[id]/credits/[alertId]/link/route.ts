// POST /api/merchants/[id]/credits/[alertId]/link { order_id } — link a captured payment to one of
// the banker's open orders it could belong to, and confirm that order with the payment's bank
// reference (lib/credit-link-store). For a payment the reconciler would not place on its own,
// because two open orders had its amount. Staff who resolve reconciliation cases only.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";
import { LinkError, linkCreditToOrder } from "@/lib/credit-link-store";

export const dynamic = "force-dynamic";

const ROLES = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE"] as const;
const schema = z.object({ order_id: z.string().uuid() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string; alertId: string }> }) {
  const g = await gateOrResponse([...ROLES]);
  if ("response" in g) return g.response;
  const { id, alertId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(alertId)) return NextResponse.json({ error: "payment not found" }, { status: 404 });
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;
  let body;
  try { body = schema.parse(await req.json()); } catch { return NextResponse.json({ error: "order_id (the order's id) is required" }, { status: 400 }); }
  try {
    const r = await linkCreditToOrder({ code: scope.code, alertId, orderId: body.order_id, actor: g.session.email });
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    if (err instanceof LinkError) return NextResponse.json({ error: err.message }, { status: err.status });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
