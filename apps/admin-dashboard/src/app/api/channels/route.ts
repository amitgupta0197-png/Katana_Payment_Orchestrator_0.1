// SUPER_ADMIN CRUD; PROVIDER R; MERCHANT ✗ (PRODUCT_VISION §3.11).
import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  try {
    // Channels live in routingengine_db.rails (1 row per provider+method+direction).
    const channels = await rows<any>("routingEngine", `
      SELECT id::text, provider, method, direction, enabled, weight, mdr_bps
        FROM rails ORDER BY direction, provider, method LIMIT 500
    `).catch(() => []);
    return NextResponse.json({ channels });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
