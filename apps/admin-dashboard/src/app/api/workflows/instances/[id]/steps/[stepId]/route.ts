// POST /api/workflows/instances/{id}/steps/{stepId}
//   { action: "complete", checklist, comment?, evidence_ref? }  the step's role (or Super Admin), all ticked
//   { action: "send_back", comment }                             fail the step: it goes to its on_fail
//   { action: "check", checklist }                               save ticks without completing
//   { action: "escalate", comment }                              ops alert + event + WORM
//   { action: "comment", comment }
// Changes the workflow only; the banker / TSP / MID / merchant itself is never changed here.

import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { commentStep, completeStep, escalateStep, saveChecklist, WORKFLOW_READ } from "@/lib/workflow-store";
import { workflowError } from "@/lib/workflow-http";

export const dynamic = "force-dynamic";

const schema = z.object({
  action: z.enum(["complete", "send_back", "check", "escalate", "comment"]),
  checklist: z.record(z.string(), z.boolean()).optional(),
  comment: z.string().max(4000).optional(),
  evidence_ref: z.string().max(500).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string; stepId: string }> }) {
  const g = await gateOrResponse(WORKFLOW_READ);
  if ("response" in g) return g.response;
  const s = g.session;
  const by = { email: s.email, persona: s.persona, id: s.user_id };
  const { id, stepId } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    switch (body.action) {
      case "complete":
        return NextResponse.json(await completeStep(id, stepId, by, { checklist: body.checklist, comment: body.comment, evidence_ref: body.evidence_ref }));
      case "send_back":
        return NextResponse.json(await completeStep(id, stepId, by, { comment: body.comment, outcome: "FAIL" }));
      case "check":
        await saveChecklist(id, stepId, by, body.checklist ?? {});
        return NextResponse.json({ ok: true });
      case "escalate":
        await escalateStep(id, stepId, by, body.comment ?? "");
        return NextResponse.json({ ok: true });
      case "comment":
        await commentStep(id, stepId, by, body.comment ?? "");
        return NextResponse.json({ ok: true });
    }
  } catch (err) { return workflowError(err); }
}
