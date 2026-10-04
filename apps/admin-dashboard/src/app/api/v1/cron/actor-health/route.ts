// POST /api/v1/cron/actor-health — recompute every actor's health (lib/health-store computeAll:
// TSPs, bankers, merchants, integrations) into the actor_health cache, record what was
// completed, alert on live actors that turn RED / BLOCKED and send the daily AMBER digest
// (lib/health-alerts). Cron-authenticated (x-cron-key). Schedule every 5 minutes:
//   */5 * * * * curl -s -X POST -H "x-cron-key: $FIFO_CRON_KEY" http://127.0.0.1:3100/api/v1/cron/actor-health

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { cronGate, runJob } from "@/lib/jobs";
import { runActorHealth } from "@/lib/health-alerts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = cronGate(req);
  if (denied) return denied;
  try {
    const out = await runJob("actor-health", 300, () => runActorHealth());
    return NextResponse.json({ ok: true, ...out });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
