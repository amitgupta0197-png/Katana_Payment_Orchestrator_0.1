// GET /api/v1/dt/reconciliation — DT invariants (BRD §15): quota closing balance,
// commission waterfall balance, stale reservations.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { reconciliation } from "@/lib/dt-engine";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  return NextResponse.json(await reconciliation());
}
