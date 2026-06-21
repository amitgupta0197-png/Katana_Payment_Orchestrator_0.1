// GET /api/v1/fraud-alerts — risk/fraud alerts raised by the FIFO module
// (BRD §23/§24). Risk/Compliance/Admin only.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "COMPLIANCE", "RISK"]);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  try {
    const params: unknown[] = ["tenant-default"];
    let where = "tenant_id = $1";
    if (status) { where += ` AND status = $${params.length + 1}`; params.push(status); }
    const alerts = await rows<any>("fifo", `
      SELECT id::text, order_id::text, order_ref, merchant_id, alert_type, severity, detail, payload, status, created_at
        FROM fifo_fraud_alerts WHERE ${where}
       ORDER BY created_at DESC LIMIT 200
    `, params);
    return NextResponse.json({ alerts });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
