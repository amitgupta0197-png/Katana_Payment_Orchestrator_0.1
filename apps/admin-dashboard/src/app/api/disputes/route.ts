// GET  /api/disputes — list (filtered by persona scope)
// POST /api/disputes — open a dispute (admin or system)

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { openDispute } from "@/lib/disputes";
import { publish } from "@/lib/events";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN","PROVIDER","MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");

  try {
    const where: string[] = ["tenant_id='tenant-default'"];
    const params: unknown[] = [];
    if (s.persona === "MERCHANT") { params.push(s.scope_id); where.push(`merchant_id = $${params.length}`); }
    // P0 fix from audit: PROVIDER was unscoped → seeing all tenant disputes.
    // Now restricted to its own mapped merchants.
    if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ disputes: [] });
      params.push(ids);
      where.push(`merchant_id = ANY($${params.length}::text[])`);
    }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    const disputes = await rows<any>("riskVelocity", `
      SELECT dispute_id::text, txn_id, order_id::text, merchant_id, reason_code,
             amount_minor::text, currency, status, deadline_at,
             opened_at, COALESCE(opened_by,'') AS opened_by,
             resolved_at, COALESCE(resolved_by,'') AS resolved_by,
             COALESCE(resolution_notes,'') AS resolution_notes,
             hold_journal_id::text, resolution_journal_id::text
        FROM disputes
       WHERE ${where.join(" AND ")}
       ORDER BY opened_at DESC LIMIT 200
    `, params);
    return NextResponse.json({ disputes });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  txn_id:       z.string().min(1),
  merchant_id:  z.string().optional(),
  reason_code:  z.string().default("10.4 fraud"),
  amount_minor: z.union([z.string(), z.number()]),
  currency:     z.string().default("INR"),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = createSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    let merchantId = body.merchant_id;
    let orderId: string | undefined;
    if (!merchantId) {
      const o = await rows<any>("checkout",
        "SELECT id::text, merchant_id FROM checkout_orders WHERE txn_id=$1 LIMIT 1",
        [body.txn_id]);
      if (!o.length) return NextResponse.json({ error: "txn not found and no merchant_id supplied" }, { status: 404 });
      merchantId = o[0].merchant_id;
      orderId = o[0].id;
    }
    const result = await openDispute({
      txnId: body.txn_id, orderId,
      merchantId: merchantId!, reasonCode: body.reason_code,
      amountMinor: body.amount_minor, currency: body.currency,
      openedBy: s.email,
    });
    await publish({
      eventType: "risk.alert", producer: "risk_engine",
      entityType: "payment", entityId: orderId ?? body.txn_id, actorId: s.user_id,
      payload: { kind: "dispute_opened", dispute_id: result.dispute_id, amount_minor: String(body.amount_minor) },
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = (err as Error).message;
    if (/cannot transition|unbalanced/i.test(msg))
      return NextResponse.json({ error: msg }, { status: 400 });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
