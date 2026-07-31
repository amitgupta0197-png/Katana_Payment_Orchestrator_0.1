// GET /api/v1/dt/reserves — per-lot security reserve positions (BRD §9 "Security
// Reserves", §5). Outstanding = held − released. Release requires approval (OD-03).
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { reserveRows } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  const reserves = await reserveRows();
  const totals = reserves.reduce(
    (acc: any, r: any) => ({
      held: acc.held + r.held,
      released: acc.released + r.released,
      outstanding: acc.outstanding + r.outstanding,
    }),
    { held: 0, released: 0, outstanding: 0 },
  );
  return NextResponse.json({ reserves, totals });
}
