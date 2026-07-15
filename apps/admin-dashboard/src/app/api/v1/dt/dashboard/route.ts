// GET /api/v1/dt/dashboard — DT KPIs (BRD §10 UI-001) + current rate. Admin/Finance-gated.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { dashboardKpis, currentRate } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  const banker = new URL(req.url).searchParams.get("banker") || undefined;
  const [kpis, rate] = await Promise.all([dashboardKpis({ banker_id: banker }), currentRate()]);
  return NextResponse.json({ kpis, rate });
}
