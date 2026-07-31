// POST /api/v1/cron/dt-alerts — scheduled half of BRD §16 "Refill and Alerts".
//
// Evaluates every banker's remaining priority quota and materialises a refill request
// for anyone at or below the 15% threshold (or fully exhausted). Idempotent: a banker
// that already has an OPEN or FUNDED request is skipped, so running this every few
// minutes cannot pile up duplicate requests.
//
// Guarded by x-cron-key like the other crons. Suggested schedule:
//   */15 * * * * curl -s -X POST -H "x-cron-key: $FIFO_CRON_KEY" \
//     http://127.0.0.1:3100/api/v1/cron/dt-alerts >> /var/log/katana-dt-alerts.log 2>&1
import { NextResponse } from "next/server";
import { refillAlerts, createRefillSuggestions } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const key = process.env.FIFO_CRON_KEY;
  if (!key) return NextResponse.json({ error: "cron disabled (FIFO_CRON_KEY unset)" }, { status: 503 });
  if (req.headers.get("x-cron-key") !== key) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const alerts = await refillAlerts();
  const result = await createRefillSuggestions("cron:dt-alerts");

  // Return the full picture, not just what changed — the log line then records the
  // state that justified (or didn't justify) each action.
  return NextResponse.json({
    ok: true,
    evaluated: alerts.length,
    breaching: alerts.filter((a) => a.level !== "OK").map((a) => ({
      banker_id: a.banker_id, level: a.level, available_pct: a.available_pct,
    })),
    funding_overdue: alerts.filter((a) => a.funding_overdue).map((a) => a.banker_id),
    ...result,
  });
}
