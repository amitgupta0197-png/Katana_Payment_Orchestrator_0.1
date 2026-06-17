// GET /api/admin/hardening — production-readiness scorecard.
import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { evaluateAll, summarise } from "@/lib/hardening";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const checks = await evaluateAll();
    return NextResponse.json({ checks, summary: summarise(checks) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
