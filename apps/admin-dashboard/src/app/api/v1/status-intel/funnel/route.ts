// GET /api/v1/status-intel/funnel — canonical status counts for the merchant
// dashboard funnel (BRD Layer 8 real-time status funnel).

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { getFunnel, FUNNEL_ORDER } from "@/lib/status-intelligence";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE", "RISK", "COMPLIANCE", "MERCHANT"]);
  if ("response" in g) return g.response;
  try {
    const f = await getFunnel();
    return NextResponse.json({ ...f, order: FUNNEL_ORDER });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
