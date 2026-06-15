// SUPER_ADMIN CRUD; PROVIDER R (PRODUCT_VISION §3.11).
import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  try {
    const rules = await rows<any>("routingEngine", `
      SELECT id::text, name, priority, method, min_amount, max_amount, weights, enabled, created_at
        FROM routing_rules ORDER BY priority ASC, created_at DESC LIMIT 200
    `).catch(() => []);
    const rails = await rows<any>("routingEngine", `
      SELECT id::text, provider, method, direction, enabled, weight, mdr_bps, config
        FROM rails ORDER BY provider, method LIMIT 200
    `).catch(() => []);
    const health = await rows<any>("routingEngine", `
      SELECT rail_id::text, success_rate_bps, p95_latency_ms, last_checked_at
        FROM rail_health LIMIT 200
    `).catch(() => []);
    return NextResponse.json({ rules, rails, health });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
