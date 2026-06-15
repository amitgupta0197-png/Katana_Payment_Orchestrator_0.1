// SUPER_ADMIN toggles routing rule enable/disable + adjusts priority.
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const schema = z.object({
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.enabled !== undefined) { args.push(body.enabled); sets.push(`enabled = $${args.length}`); }
  if (body.priority !== undefined) { args.push(body.priority); sets.push(`priority = $${args.length}`); }
  if (!sets.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  args.push(id);
  try {
    const res = await rows<any>("routingEngine", `
      UPDATE routing_rules SET ${sets.join(", ")} WHERE id = $${args.length}::uuid
       RETURNING id::text, name, enabled, priority
    `, args);
    if (!res.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(res[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
