// POST /api/v1/cases — open a compliance case (BRD §23). GET — list cases.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { createCase } from "@/lib/fifo-cases";

export const dynamic = "force-dynamic";

const schema = z.object({
  subject: z.string().min(1),
  merchant_id: z.string().optional(),
  order_ref: z.string().optional(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "COMPLIANCE", "RISK"]);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try {
    const r = await createCase({ subject: body.subject, merchantId: body.merchant_id, orderRef: body.order_ref, severity: body.severity, openedBy: g.session.email });
    return NextResponse.json({ case: r }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "COMPLIANCE", "RISK"]);
  if ("response" in g) return g.response;
  const status = new URL(req.url).searchParams.get("status");
  try {
    const params: unknown[] = [];
    let where = "1=1";
    if (status) { where += ` AND status = $${params.length + 1}`; params.push(status); }
    const cases = await rows<any>("fifo", `
      SELECT id::text, case_ref, subject, merchant_id, order_ref, severity, status, opened_by, assigned_to, created_at, closed_at
        FROM fifo_cases WHERE ${where} ORDER BY created_at DESC LIMIT 200
    `, params);
    return NextResponse.json({ cases });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
