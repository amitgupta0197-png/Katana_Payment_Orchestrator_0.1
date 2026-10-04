// GET|POST /api/v1/cron/callback-verify — re-checks bankers' callback URLs (lib/callback-verify).
// Each run checks, oldest first, every per-flow callback URL (banker_callback_urls) and every
// LIVE banker's default webhook_url not checked in the last 6 hours, at most BATCH per run and
// a few at a time. Each check is a signed test event; any 2xx passes. Failures raise an amber
// alert, three in a row a red one. Leaves a heartbeat (job_heartbeats, `callback-verify`).
// Cron-authenticated (x-cron-key). Schedule every 30 minutes:
//   */30 * * * * curl -s -X POST -H "x-cron-key: $FIFO_CRON_KEY" http://127.0.0.1:3100/api/v1/cron/callback-verify

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { cronGate, runJob } from "@/lib/jobs";
import { dueChecks, verifyCallback } from "@/lib/callback-verify";
import { RECHECK_HOURS } from "@/lib/integration";

export const dynamic = "force-dynamic";

const BATCH = 60;
const PARALLEL = 6;

async function run(req: Request) {
  const denied = cronGate(req);
  if (denied) return denied;
  try {
    const out = await runJob("callback-verify", 1800, async () => {
      const due = await dueChecks(RECHECK_HOURS, BATCH);
      let passed = 0, failed = 0;
      const errors: string[] = [];
      for (let i = 0; i < due.length; i += PARALLEL) {
        await Promise.all(due.slice(i, i + PARALLEL).map(async (d) => {
          try {
            const r = await verifyCallback({ merchantId: d.merchant_id, flow: d.flow, triggeredBy: "SCHEDULED" });
            if (r.ok) passed += 1; else failed += 1;
          } catch (e) { errors.push(`${d.merchant_id}/${d.flow ?? "DEFAULT"}: ${(e as Error).message}`); }
        }));
      }
      return { checked: due.length, passed, failed, errors: errors.slice(0, 10) };
    });
    return NextResponse.json({ ok: true, ...out });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export const GET = run;
export const POST = run;
