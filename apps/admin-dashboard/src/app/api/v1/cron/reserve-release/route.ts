// POST /api/v1/cron/reserve-release — releases every reserve hold whose release date has passed
// (lib/reserves): RESERVE → PAYABLE in the ledger, one journal per hold, idempotent. Until now
// this only ran when a Super Admin pressed the settlement trigger.
// Cron-authenticated (x-cron-key). Schedule hourly:
//   0 * * * * curl -s -X POST -H "x-cron-key: $FIFO_CRON_KEY" http://127.0.0.1:3100/api/v1/cron/reserve-release

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { cronGate, runJob } from "@/lib/jobs";
import { releaseDueReserves } from "@/lib/reserves";
import { broadcastToAdmins, inr, telegramConfigured } from "@/lib/telegram";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = cronGate(req);
  if (denied) return denied;
  try {
    const r = await runJob("reserve-release", 3600, () => releaseDueReserves());
    if (r.released > 0 && telegramConfigured())
      await broadcastToAdmins(`🔓 <b>${r.released} reserve hold${r.released === 1 ? "" : "s"} released</b>\n${inr(Number(r.total_minor) / 100)} moved from reserve to payable.`).catch(() => {});
    return NextResponse.json({ ok: true, ...r });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
