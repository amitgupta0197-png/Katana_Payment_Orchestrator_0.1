// PATCH /api/recon/breaks/[id] — assign owner / change status / add notes.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";

export const dynamic = "force-dynamic";

const schema = z.object({
  status: z.enum(["OPEN","INVESTIGATING","RESOLVED","FORCED_CLOSE"]).optional(),
  assignee: z.string().optional(),
  notes: z.string().optional(),
  resolution_kind: z.string().optional(),
  resolution_ref: z.string().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const before = (await rows<any>("reconciliation",
      "SELECT status, assignee, reference FROM recon_breaks WHERE id=$1::uuid", [id]))[0];
    if (!before) return NextResponse.json({ error: "break not found" }, { status: 404 });

    const sets: string[] = []; const args: unknown[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      args.push(v); sets.push(`${k} = $${args.length}`);
    }
    if (!sets.length) return NextResponse.json({ error: "no fields supplied" }, { status: 400 });
    if (body.status === "RESOLVED" || body.status === "FORCED_CLOSE") {
      sets.push(`resolved_at = now()`);
      args.push(s.email); sets.push(`resolved_by = $${args.length}`);
    }
    args.push(id);
    const r = await rows<any>("reconciliation",
      `UPDATE recon_breaks SET ${sets.join(", ")} WHERE id=$${args.length}::uuid
       RETURNING id::text, status, assignee, COALESCE(notes,'') AS notes`, args);
    await wormAppend({
      actorId: s.user_id, actorEmail: s.email,
      action: `recon.break.${(body.status ?? "update").toLowerCase()}`,
      resourceType: "recon_break", resourceId: id,
      before, after: body,
    }).catch(() => null);
    return NextResponse.json({ ok: true, ...r[0] });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
