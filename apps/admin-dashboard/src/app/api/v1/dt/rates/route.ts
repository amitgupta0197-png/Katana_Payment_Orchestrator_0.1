// GET /api/v1/dt/rates — full rate card history (BRD §9 "DT Rate Cards", §5 "DT Rate
// — positive decimal; versioned"). Setting a new rate stays on /rates/current; this is
// the read side so Finance can see what every historic advance was priced at.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { rateCardHistory, currentRate } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  const [cards, current] = await Promise.all([rateCardHistory(), currentRate()]);
  return NextResponse.json({ cards, current });
}
