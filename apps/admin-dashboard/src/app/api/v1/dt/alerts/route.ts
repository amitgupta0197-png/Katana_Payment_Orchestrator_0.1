// DT refill alerts (BRD §16 "Refill and Alerts") — session-gated admin side.
//
//   GET  — evaluate every banker against the threshold ladder. Pure read, no writes.
//   POST — materialise refill suggestions now, for an operator who does not want to
//          wait for the schedule. Idempotent (a banker with an OPEN/FUNDED request is
//          skipped). The scheduled equivalent is POST /api/v1/cron/dt-alerts.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { refillAlerts, createRefillSuggestions } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  const alerts = await refillAlerts();
  return NextResponse.json({
    alerts,
    summary: {
      pause: alerts.filter((a) => a.level === "PAUSE").length,
      refill: alerts.filter((a) => a.level === "REFILL").length,
      warn: alerts.filter((a) => a.level === "WARN").length,
      overdue: alerts.filter((a) => a.funding_overdue).length,
    },
  });
}

export async function POST() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
  if ("response" in g) return g.response;
  const result = await createRefillSuggestions(g.session.email);
  return NextResponse.json({ ok: true, ...result });
}
