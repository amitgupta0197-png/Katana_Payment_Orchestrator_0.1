// GET /api/admin/routing/health — provider health + circuit state + kill-switch
// status, one row per (provider, method).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { config as circuitConfig } from "@/lib/circuit-breaker";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const rails = await rows<any>("routingEngine", `
      SELECT provider, method, direction, enabled, kill_switch, mdr_bps,
             COALESCE(kill_switch_reason,'') AS kill_switch_reason,
             kill_switch_at, COALESCE(kill_switch_by,'') AS kill_switch_by
        FROM rails
       ORDER BY provider, direction, method
    `);
    const health = await rows<any>("routingEngine", `
      SELECT provider_code, success_rate::float AS success_rate,
             p95_latency_ms, failure_rate::float AS failure_rate,
             utilization::float AS utilization,
             circuit_state, consecutive_failures,
             circuit_opened_at, half_open_at, last_failure_at, last_success_at,
             updated_at
        FROM provider_health_snapshot
       ORDER BY provider_code
    `);
    return NextResponse.json({ rails, health, circuit_config: circuitConfig() });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
