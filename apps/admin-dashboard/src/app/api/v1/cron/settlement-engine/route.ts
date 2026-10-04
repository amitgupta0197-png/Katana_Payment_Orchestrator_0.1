// POST /api/v1/cron/settlement-engine — the Settlement Engine's clock (lib/settlement-engine-store).
// Each run, in order:
//   1. ledger-sync: paid pay-ins, chargeback postings and hand-raised settlements onto the ledger
//      (bounded passes; a first run backfills history over several runs)
//   2. follow every open instruction's banker→merchant request (paid → in transit, verified →
//      settled, rejected → failed, reversed → reversed), posting the journals
//   3. raise every settlement cycle that is due (T+0 / T+1 / T+2 / weekly / instant)
//   4. release reserve holds that are due
// Everything it does is idempotent, so a run that overlaps or repeats changes nothing twice.
// Cron-authenticated (x-cron-key). Schedule every 5 minutes:
//   */5 * * * * curl -s -X POST -H "x-cron-key: $FIFO_CRON_KEY" http://127.0.0.1:3100/api/v1/cron/settlement-engine

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { cronGate, runJob } from "@/lib/jobs";
import { syncLedger } from "@/lib/ledger-sync";
import { followRequests, releaseReserves, runDueCycles } from "@/lib/settlement-engine-store";
import { setAlert } from "@/lib/ops-alert";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = cronGate(req);
  if (denied) return denied;
  try {
    const out = await runJob("settlement-engine", 300, async () => {
      const sync = { payins: 0, chargebacks: 0, manual: 0, manual_reversed: 0, errors: [] as string[] };
      for (let pass = 0; pass < 10; pass++) {
        const s = await syncLedger();
        sync.payins += s.payins; sync.chargebacks += s.chargebacks; sync.manual += s.manual; sync.manual_reversed += s.manual_reversed;
        sync.errors.push(...s.errors);
        if (s.payins + s.chargebacks + s.manual + s.manual_reversed === 0 || s.errors.length) break;
      }
      const followed = await followRequests();
      const cycles = await runDueCycles();
      const reserves = await releaseReserves();
      return { sync, followed, cycles, reserves };
    });
    const errors = [...out.sync.errors, ...out.followed.errors, ...out.cycles.errors, ...out.reserves.errors];
    await setAlert(errors.length > 0, {
      key: "settlement-engine:errors", severity: "WARN",
      title: `Settlement engine: ${errors.length} item${errors.length === 1 ? "" : "s"} could not be processed`,
      body: errors.slice(0, 8).join("\n"), repeatMinutes: 180,
    }).catch(() => {});
    return NextResponse.json({ ok: true, ...out });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
