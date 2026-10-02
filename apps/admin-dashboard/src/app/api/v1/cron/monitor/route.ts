// POST /api/v1/cron/monitor — the ops monitor (lib/ops-monitor): conditions that need a person,
// sent to the admin Telegram chats once each and again only after a quiet period.
// Cron-authenticated (x-cron-key). Schedule every five minutes:
//   */5 * * * * curl -s -X POST -H "x-cron-key: $FIFO_CRON_KEY" http://127.0.0.1:3100/api/v1/cron/monitor

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { cronGate, runJob } from "@/lib/jobs";
import { runMonitor } from "@/lib/ops-monitor";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = cronGate(req);
  if (denied) return denied;
  try {
    return NextResponse.json({ ok: true, ...(await runJob("monitor", 300, runMonitor)) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
