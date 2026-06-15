// SUPER_ADMIN CRUD; PROVIDER C invite into own; MERCHANT C invite into own (PRODUCT_VISION §3.11).
import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const users = await rows<any>("auth", `
      SELECT id::text, email::text, COALESCE(full_name,'') AS full_name, status,
             created_at, updated_at
        FROM users ORDER BY created_at DESC LIMIT 500
    `).catch(() => []);
    return NextResponse.json({ users });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
