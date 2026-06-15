// PATCH (revoke) / DELETE single API key. Scoped to owner persona.
import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

async function authorizeKeyAccess(id: string, persona: string, scopeId: string | null) {
  const cur = await rows<any>("auth", `SELECT owner_kind, owner_id, status FROM api_keys WHERE id = $1::uuid`, [id]);
  if (!cur.length) return { error: "not found", status: 404 as const, key: null };
  if (persona === "SUPER_ADMIN") return { key: cur[0] };
  if (persona === "PROVIDER" && cur[0].owner_kind === "PROVIDER" && cur[0].owner_id === scopeId) return { key: cur[0] };
  if (persona === "MERCHANT" && cur[0].owner_kind === "MERCHANT" && cur[0].owner_id === scopeId) return { key: cur[0] };
  return { error: "not authorized", status: 403 as const, key: null };
}

export async function PATCH(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const a = await authorizeKeyAccess(id, g.session.persona, g.session.scope_id);
  if (a.error) return NextResponse.json({ error: a.error }, { status: a.status });
  try {
    const res = await rows<any>("auth", `
      UPDATE api_keys SET status='REVOKED', revoked_at=now() WHERE id=$1::uuid
       RETURNING id::text, label, status, revoked_at
    `, [id]);
    return NextResponse.json(res[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const res = await rows<any>("auth", `DELETE FROM api_keys WHERE id=$1::uuid RETURNING id::text`, [id]);
    if (!res.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ deleted: res[0].id });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
