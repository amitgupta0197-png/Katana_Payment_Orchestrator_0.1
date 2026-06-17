// PATCH /api/admin/incidents/[id] — transition state.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { transitionIncident, type IncidentStatus } from "@/lib/incidents";
import { wormAppend } from "@/lib/worm";

export const dynamic = "force-dynamic";

const schema = z.object({
  to: z.enum(["INVESTIGATING","MITIGATING","RESOLVED","POST_MORTEM"]),
  notes: z.string().optional(),
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
    const result = await transitionIncident({
      incidentId: id, to: body.to as IncidentStatus,
      actorEmail: s.email, notes: body.notes,
    });
    await wormAppend({
      actorId: s.user_id, actorEmail: s.email,
      action: `incident.${body.to.toLowerCase()}`,
      resourceType: "incident", resourceId: id,
      before: { status: result.from }, after: { status: result.to },
      notes: body.notes,
    }).catch(() => null);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = (err as Error).message;
    if (/cannot transition|not found/.test(msg)) return NextResponse.json({ error: msg }, { status: 409 });
    const e = pgError(err); return NextResponse.json(e.body, { status: e.status });
  }
}
