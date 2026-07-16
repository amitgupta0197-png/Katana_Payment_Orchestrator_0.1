// GET /api/v1/dt/dashboard — DT KPIs (BRD §10 UI-001) + current rate + open refill
// requests (so banker-raised refills are traceable from the dashboard). Admin/Finance-gated.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { rows } from "@/lib/pg";
import { dashboardKpis, currentRate, bankerBreakdown } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  const banker = new URL(req.url).searchParams.get("banker") || undefined;
  const [kpis, rate, bankers, refills] = await Promise.all([
    dashboardKpis({ banker_id: banker }),
    currentRate(),
    bankerBreakdown(),
    rows<any>("provider", `
      SELECT id::text, banker_id, quantity::float AS quantity, trigger, status, created_by, created_at
        FROM dt_refill_requests
       WHERE status IN ('OPEN','FUNDED') ${banker ? "AND banker_id = $1" : ""}
       ORDER BY created_at DESC LIMIT 10
    `, banker ? [banker] : []).catch(() => []),
  ]);
  return NextResponse.json({ kpis, rate, bankers, open_refills: refills });
}
