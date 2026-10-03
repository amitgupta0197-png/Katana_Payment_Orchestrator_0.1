// GET /api/merchant-readiness — every merchant with what it was onboarded for (services and
// pay-in flow) and, per banker, what go-live still needs (lib/merchant-setup). Staff only: the
// hints speak of gateways.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { merchantReadiness } from "@/lib/merchant-setup";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const merchants = await merchantReadiness();
    return NextResponse.json({
      merchants,
      counts: {
        merchants: merchants.length,
        nothing_selected: merchants.filter((m) => m.services === "UNSET" && m.flow.flow === "UNSET").length,
        live_not_ready: merchants.reduce((n, m) => n + m.live_not_ready, 0),
      },
      as_of: new Date().toISOString(),
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
