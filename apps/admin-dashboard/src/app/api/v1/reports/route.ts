// GET /api/v1/reports?type=merchant|operator|settlement|risk|forensic (BRD §30).

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { buildReport, REPORT_TYPES, type ReportType } from "@/lib/fifo-reports";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK", "COMPLIANCE"]);
  if ("response" in g) return g.response;
  const type = (new URL(req.url).searchParams.get("type") ?? "merchant") as ReportType;
  if (!REPORT_TYPES.includes(type)) return NextResponse.json({ error: `unknown report type` }, { status: 400 });
  try {
    const report = await buildReport(type);
    return NextResponse.json({ type, ...report });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
