// SUPER_ADMIN only (PRODUCT_VISION §3.11).
import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const providers = await rows<any>("pgAdapter", `
      SELECT id::text, code, name, mdr_bps, enabled, health, success_rate_bps, created_at
        FROM pg_providers ORDER BY code LIMIT 100
    `).catch(() => []);
    const credentials = await rows<any>("pgAdapter", `
      SELECT id::text, provider, env, active, created_at
        FROM pg_credentials ORDER BY provider, env LIMIT 100
    `).catch(() => []);
    return NextResponse.json({ providers, credentials });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
