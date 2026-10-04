// GET /api/workflows/instances/{id} — one instance, synced with the real state first: its
// template's steps (state, SLA, checklist, system check, linked Maker-Checker request) and every
// event. Staff only.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { instanceDetail, WORKFLOW_READ } from "@/lib/workflow-store";
import { workflowError } from "@/lib/workflow-http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(WORKFLOW_READ);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const d = await instanceDetail(id, { persona: g.session.persona });
    return NextResponse.json({ ...d, you: { persona: g.session.persona, email: g.session.email } });
  } catch (err) { return workflowError(err); }
}
