// SUPER_ADMIN CRUD; PROVIDER R mapped (PRODUCT_VISION §3.11).
import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  try {
    const agents = await rows<any>("agentFranchise", `
      SELECT id::text, tenant_id, code, COALESCE(parent_id::text,'') AS parent_id, tier,
             legal_name, contact_email, COALESCE(contact_phone,'') AS contact_phone,
             status, advance_balance, currency, low_balance_threshold, created_at
        FROM agents WHERE tenant_id = 'tenant-default'
       ORDER BY tier, code LIMIT 200
    `).catch(() => []);
    return NextResponse.json({ agents });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
