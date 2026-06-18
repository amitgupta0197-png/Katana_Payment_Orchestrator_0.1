// SUPER_ADMIN only.
import { NextResponse } from "next/server";
import { z } from "zod";
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

const createSchema = z.object({
  code: z.string().min(2).max(60),
  name: z.string().min(2).max(255),
  type: z.enum(["PLATFORM", "PROVIDER", "MERCHANT"]),
  parent_id: z.string().uuid().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  let body;
  try { body = createSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const res = await rows<any>("tenant", `
      INSERT INTO tenants (parent_id, type, code, name, status)
      VALUES ($1::uuid, $2, $3, $4, 'ACTIVE')
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name, type = EXCLUDED.type, updated_at = now()
      RETURNING id::text, COALESCE(parent_id::text,'') AS parent_id, type, code, name, status, created_at
    `, [body.parent_id ?? null, body.type, body.code, body.name]);
    return NextResponse.json(res[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
