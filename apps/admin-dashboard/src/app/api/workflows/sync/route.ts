// POST /api/workflows/sync — run what the cron runs, now: start the instances that should be
// running, sync every open one, alert on SLA breaches. Super Admin / Admin.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { alertBreaches, syncAll, WORKFLOW_ADMIN } from "@/lib/workflow-store";
import { workflowError } from "@/lib/workflow-http";

export const dynamic = "force-dynamic";

export async function POST() {
  const g = await gateOrResponse(WORKFLOW_ADMIN);
  if ("response" in g) return g.response;
  try {
    const sync = await syncAll();
    const sla = await alertBreaches();
    return NextResponse.json({ ok: true, ...sync, errors: sync.errors.slice(0, 20), sla });
  } catch (err) { return workflowError(err); }
}
