// GET /api/refunds — list
// POST /api/refunds — create + post journal

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { createRefund } from "@/lib/refunds";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN","PROVIDER","MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  try {
    const wh: string[] = ["tenant_id='tenant-default'"];
    const params: unknown[] = [];
    if (s.persona === "MERCHANT") { params.push(s.scope_id); wh.push(`merchant_id=$${params.length}`); }
    const refunds = await rows<any>("checkout", `
      SELECT refund_id::text, order_id::text, txn_id, merchant_id,
             amount_minor::text, currency, reason, status, partial,
             journal_id::text, COALESCE(requested_by,'') AS requested_by,
             requested_at, posted_at, COALESCE(failure_reason,'') AS failure_reason
        FROM refunds WHERE ${wh.join(" AND ")}
       ORDER BY requested_at DESC LIMIT 200
    `, params).catch(() => []);
    return NextResponse.json({ refunds });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  txn_id: z.string().min(1),
  amount_minor: z.union([z.string(), z.number()]),
  currency: z.string().default("INR"),
  reason: z.string().min(1).default("customer_request"),
  partial: z.boolean().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN","MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const result = await createRefund({
      txnId: body.txn_id, amountMinor: body.amount_minor,
      currency: body.currency, reason: body.reason,
      partial: body.partial, requestedBy: s.email,
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = (err as Error).message;
    if (/not found|exceeds|cannot refund|unbalanced/i.test(msg))
      return NextResponse.json({ error: msg }, { status: 400 });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
