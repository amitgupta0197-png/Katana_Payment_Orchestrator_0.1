// GET /api/ops/gateway-health — one row per pay-in gateway over the last 24 hours, with the
// alerts its figures raise (lib/gateway-performance). STAFF ONLY: it names gateways.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { STAFF_PERSONAS } from "@/lib/portal-scope";
import { gatewayHealth, GATEWAY_ALERT_TEXT } from "@/lib/gateway-performance";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(STAFF_PERSONAS);
  if ("response" in g) return g.response;
  try {
    return NextResponse.json({ gateways: await gatewayHealth(24), alert_text: GATEWAY_ALERT_TEXT, as_of: new Date().toISOString() });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
