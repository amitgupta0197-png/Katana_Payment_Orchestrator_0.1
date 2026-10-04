// GET  /api/workflows/instances — workflow instances (the Journey Tracker). Filters: actor_type,
//      template, role (the current step's), sla (ON_TRACK / AT_RISK / BREACHED), status, actor_id.
// POST /api/workflows/instances — start a template for an actor: { template, actor_id }.
// Staff only (lib/workflow-store WORKFLOW_READ / WORKFLOW_START).

import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { listInstances, startInstance, WORKFLOW_READ, WORKFLOW_START } from "@/lib/workflow-store";
import { workflowError } from "@/lib/workflow-http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(WORKFLOW_READ);
  if ("response" in g) return g.response;
  const u = new URL(req.url).searchParams;
  const pick = (k: string) => u.get(k)?.trim() || undefined;
  try {
    const instances = await listInstances({
      actor_type: pick("actor_type"), template: pick("template"), role: pick("role"), sla: pick("sla"), status: pick("status"), actor_id: pick("actor_id"),
    });
    return NextResponse.json({ instances, you: { persona: g.session.persona, email: g.session.email } });
  } catch (err) { return workflowError(err); }
}

const startSchema = z.object({ template: z.string().min(2).max(48), actor_id: z.string().uuid() });

export async function POST(req: Request) {
  const g = await gateOrResponse(WORKFLOW_START);
  if ("response" in g) return g.response;
  let body;
  try { body = startSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const r = await startInstance(body.template, body.actor_id, g.session.email);
    return NextResponse.json(r, { status: 201 });
  } catch (err) { return workflowError(err); }
}
