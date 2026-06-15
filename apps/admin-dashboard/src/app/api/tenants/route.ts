// SUPER_ADMIN only.
import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const tenants = await rows<any>("tenant", `
      SELECT id::text, COALESCE(parent_id::text,'') AS parent_id, type, code, name, status, created_at
        FROM tenants ORDER BY created_at DESC LIMIT 200
    `).catch(() => []);
    return NextResponse.json({ tenants });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
