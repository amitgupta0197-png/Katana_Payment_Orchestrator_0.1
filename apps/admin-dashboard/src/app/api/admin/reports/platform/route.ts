// GET /api/admin/reports/platform?hours=24 — the platform's day so far and each gateway's
// performance over the window (lib/gateway-performance). Staff only: it names gateways.
import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { gatewayPerformance, isUnhealthy, platformSummary, HEALTH_MIN_RATE, HEALTH_MIN_SAMPLE, HEALTH_SAMPLE } from "@/lib/gateway-performance";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const hours = Math.min(Math.max(Number(new URL(req.url).searchParams.get("hours") ?? 24) || 24, 1), 24 * 31);
  try {
    const [summary, gateways] = await Promise.all([platformSummary(), gatewayPerformance(hours)]);
    return NextResponse.json({
      summary, hours,
      gateways: gateways.map((x) => ({ ...x, unhealthy: isUnhealthy(x) })),
      health_rule: { min_rate: HEALTH_MIN_RATE, min_sample: HEALTH_MIN_SAMPLE, over_last: HEALTH_SAMPLE },
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
