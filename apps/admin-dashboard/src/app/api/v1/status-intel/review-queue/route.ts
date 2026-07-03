// GET /api/v1/status-intel/review-queue — low-confidence / unmatched signals
// awaiting manual disambiguation (BRD Layer 3: below 75% confidence → manual review).

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { getReviewQueue } from "@/lib/status-intelligence";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  try {
    return NextResponse.json({ queue: await getReviewQueue() });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
