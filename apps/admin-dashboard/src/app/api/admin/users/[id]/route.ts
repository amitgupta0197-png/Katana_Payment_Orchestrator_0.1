// GET   /api/admin/users/[id] — full user + persona assignments
// PATCH /api/admin/users/[id] — update status (active/suspended/disabled)
// DELETE — soft-delete via status=disabled
//
// SUPER_ADMIN only — invite/disable/impersonate paths flow through here.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  try {
    const userRows = await rows<any>("auth", `
      SELECT id::text, email::text, COALESCE(full_name,'') AS full_name, status,
             COALESCE(password_hash,'') AS password_hash, created_at, updated_at
        FROM users WHERE id = $1::uuid LIMIT 1
    `, [id]).catch(() => []);
    if (!userRows.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    const user = userRows[0];
    const personas = await rows<any>("iam", `
      SELECT id::text, persona_kind, COALESCE(scope_id,'') AS scope_id,
             COALESCE(scope_label,'') AS scope_label, is_primary,
             COALESCE(granted_by,'') AS granted_by, granted_at
        FROM user_personas WHERE user_id = $1::uuid ORDER BY granted_at DESC
    `, [id]).catch(() => []);
    return NextResponse.json({ user, personas });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const patchSchema = z.object({
  status: z.enum(["active", "suspended", "disabled"]).optional(),
  full_name: z.string().min(1).max(255).optional(),
  notes: z.string().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  let body;
  try { body = patchSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const sets: string[] = [];
  const args: unknown[] = [];
  let i = 1;
  if (body.status)    { sets.push(`status = $${i++}`); args.push(body.status); }
  if (body.full_name) { sets.push(`full_name = $${i++}`); args.push(body.full_name); }
  if (!sets.length)   return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  sets.push(`updated_at = now()`);
  args.push(id);

  try {
    const before = await rows<any>("auth", `SELECT status, full_name FROM users WHERE id=$1::uuid`, [id]);
    const r = await rows<any>("auth", `
      UPDATE users SET ${sets.join(", ")} WHERE id = $${i}::uuid
      RETURNING id::text, email::text, status, full_name, updated_at
    `, args);
    if (!r.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    await wormAppend({
      actorId: s.user_id, actorEmail: s.email,
      action: "user.update",
      resourceType: "user", resourceId: id,
      before: before[0] ?? {}, after: r[0],
      notes: body.notes,
    }).catch(() => null);
    return NextResponse.json(r[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
