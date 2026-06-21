// POST /api/v1/queue/sweep — auto-reassign assigned items whose accept-by SLA
// expired (BRD §15 steps 9-11, §29). Mirrors the reserve/settlement sweeps:
// idempotent, safe to call repeatedly (operator console polls it; can also be
// wired to a cron). Returns what was requeued vs escalated to HOLD.

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { sweepSlaBreaches, sweepAssignmentSla, sweepVerificationSla } from "@/lib/fifo";

export const dynamic = "force-dynamic";

export async function POST(_req: Request) {
  const g = await gateOrResponse(["OPERATOR", "SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;

  try {
    const r = await sweepSlaBreaches();
    const a = await sweepAssignmentSla();
    const v = await sweepVerificationSla();
    return NextResponse.json({ ok: true, ...r, ...a, ...v });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
