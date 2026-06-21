// POST /api/v1/anomaly/scan — run the anomaly scanner (BRD Phase 3). Raises
// ANOMALY fraud alerts for outliers/spikes/off-hours activity. Risk/Admin only.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { scanAnomalies } from "@/lib/fifo-anomaly";

export const dynamic = "force-dynamic";

export async function POST() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "RISK"]);
  if ("response" in g) return g.response;
  try {
    const r = await scanAnomalies();
    return NextResponse.json({ ok: true, ...r });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
