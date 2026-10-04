// GET  /api/workflows/templates[?all=1] — the active templates (all versions with all=1), plus the
//      system checks a step may name. Staff read.
// POST /api/workflows/templates { key, name?, description?, steps, notes? } — propose a new version.
//      Validated now; a second person approves it through Maker-Checker (`workflow.template_update`).
//      Super Admin / Admin.

import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { listTemplates, proposeTemplateVersion, WORKFLOW_ADMIN, WORKFLOW_READ, WORKFLOW_TEMPLATE_UPDATE } from "@/lib/workflow-store";
import { SYSTEM_CHECKS, BANKER_STAGE_ORDER, TSP_STAGE_ORDER, type StepDef } from "@/lib/workflow";
import { workflowError } from "@/lib/workflow-http";
import { rows } from "@/lib/pg";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(WORKFLOW_READ);
  if ("response" in g) return g.response;
  const all = new URL(req.url).searchParams.get("all") === "1";
  try {
    const [templates, pending] = await Promise.all([
      listTemplates(all),
      rows<{ request_id: string; resource_id: string; maker_email: string; created_at: string; payload: { base_version?: number } }>("provider", `
        SELECT request_id::text, resource_id, COALESCE(maker_email, '') AS maker_email, created_at, payload FROM maker_checker_requests
         WHERE action = $1 AND status = 'PENDING' ORDER BY created_at`, [WORKFLOW_TEMPLATE_UPDATE]).catch(() => []),
    ]);
    const checks = [
      ...Object.entries(SYSTEM_CHECKS).map(([key, c]) => ({ key, kind: c.kind, label: c.label })),
      ...BANKER_STAGE_ORDER.slice(1).map((s) => ({ key: `banker.stage>=${s}`, kind: "banker", label: `Stage ${s} or later` })),
      { key: "banker.stage=SUSPENDED", kind: "banker", label: "Stage is SUSPENDED" },
      ...TSP_STAGE_ORDER.slice(1).map((s) => ({ key: `tsp.stage>=${s}`, kind: "tsp", label: `Stage ${s} or later` })),
    ];
    return NextResponse.json({
      templates,
      pending: pending.map((p) => ({ request_id: p.request_id, key: p.resource_id, maker_email: p.maker_email, created_at: p.created_at, base_version: p.payload?.base_version ?? null })),
      checks, can_propose: WORKFLOW_ADMIN.includes(g.session.persona),
    });
  } catch (err) { return workflowError(err); }
}

const schema = z.object({
  key: z.string().min(2).max(48),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).nullable().optional(),
  steps: z.array(z.record(z.string(), z.unknown())).min(1).max(40),
  notes: z.string().max(1000).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(WORKFLOW_ADMIN);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const r = await proposeTemplateVersion(body.key, { name: body.name, description: body.description, steps: body.steps as unknown as StepDef[] },
      { id: g.session.user_id, email: g.session.email }, body.notes);
    return NextResponse.json(r, { status: 201 });
  } catch (err) { return workflowError(err); }
}
