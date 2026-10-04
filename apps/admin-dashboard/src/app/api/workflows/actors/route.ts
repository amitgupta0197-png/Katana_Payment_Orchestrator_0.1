// GET /api/workflows/actors?type=BANKER&q= — actors a workflow may be started for (the start
// dialog on /journeys). Staff only.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { listActors, WORKFLOW_START } from "@/lib/workflow-store";
import { ACTOR_TYPES, type ActorType } from "@/lib/workflow";
import { workflowError } from "@/lib/workflow-http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(WORKFLOW_START);
  if ("response" in g) return g.response;
  const u = new URL(req.url).searchParams;
  const type = u.get("type") ?? "";
  if (!(ACTOR_TYPES as readonly string[]).includes(type)) return NextResponse.json({ error: `type must be one of ${ACTOR_TYPES.join(", ")}` }, { status: 400 });
  try {
    return NextResponse.json({ actors: await listActors(type as ActorType, (u.get("q") ?? "").slice(0, 60)) });
  } catch (err) { return workflowError(err); }
}
