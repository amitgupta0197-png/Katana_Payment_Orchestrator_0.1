// GET /api/v1/approvals — maker-checker approval queue (BRD §9). Supervisors/Risk.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "RISK", "FINANCE", "COMPLIANCE"]);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "PENDING";
  try {
    const approvals = await rows<any>("fifo", `
      SELECT id::text, action_type, resource_type, resource_id, order_ref, merchant_id,
             amount_minor::text, currency, detail, status, maker, checker, reason, created_at, decided_at
        FROM fifo_approvals
       WHERE ($1 = 'ALL' OR status = $1)
       ORDER BY created_at DESC LIMIT 200
    `, [status]);
    return NextResponse.json({ approvals });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
