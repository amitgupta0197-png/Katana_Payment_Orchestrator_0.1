// GET /api/v1/dt/allocations — per-lot traffic quota positions (BRD §9 "Traffic
// Allocations", §11). Derived operational view; journals remain the source of truth.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { allocationRows } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  const allocations = await allocationRows();
  const totals = allocations.reduce(
    (acc: any, a: any) => ({
      allocated: acc.allocated + a.allocated,
      reserved: acc.reserved + a.reserved,
      consumed: acc.consumed + a.consumed,
      available: acc.available + a.available,
    }),
    { allocated: 0, reserved: 0, consumed: 0, available: 0 },
  );
  return NextResponse.json({ allocations, totals });
}
