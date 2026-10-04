// POST /api/workflows/instances/{id}/reject { comment } — close the workflow as REJECTED.
// Super Admin, Admin or the current step's role. The actor itself (banker, TSP, MID, merchant) is
// NOT changed: reject or suspend it on its own page if that is what is meant.

import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { rejectInstance, WORKFLOW_READ } from "@/lib/workflow-store";
import { workflowError } from "@/lib/workflow-http";

export const dynamic = "force-dynamic";

const schema = z.object({ comment: z.string().min(5).max(4000) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(WORKFLOW_READ);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch {
    return NextResponse.json({ error: "say why in a comment (at least 5 characters)", code: "NOTE_REQUIRED" }, { status: 400 });
  }
  try {
    await rejectInstance(id, { email: s.email, persona: s.persona, id: s.user_id }, body.comment);
    return NextResponse.json({ ok: true, status: "REJECTED", actor_changed: false });
  } catch (err) { return workflowError(err); }
}
