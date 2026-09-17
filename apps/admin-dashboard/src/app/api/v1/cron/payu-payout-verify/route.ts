// GET/POST /api/v1/cron/payu-payout-verify — settle gateway payouts we haven't heard back about.
// (The path predates the other gateways; it now covers every payout gateway with a connector:
// PayU, RazorpayX, Cashfree and Paytm.)
//
// Gateways report a payout's result by webhook, and webhooks get lost. This sweep asks each
// gateway's status API about every payout still SUBMITTED and applies the answer, through the
// same syncProviderPayout the webhooks use, so the two can overlap safely.
//
// A payout the gateway still has no record of 30 minutes after sending is flagged for ops, never
// failed automatically: if the lookup is wrong and the money did go, failing it would invite
// the merchant to pay the same person again.
//
// It also delivers due merchant callbacks from webhook_outbox (payout and pay-in alike).
//
// Run it every minute from the server crontab, like payu-verify:
//   * * * * * curl -s -H "x-cron-key: $FIFO_CRON_KEY" http://127.0.0.1:3100/api/v1/cron/payu-payout-verify
import { NextResponse } from "next/server";
import { rows } from "@/lib/pg";
import {
  flagPayoutMissingAtProvider, PROVIDER_ORDER_COLS, syncProviderPayout, type ProviderPayoutOrder,
} from "@/lib/provider-payout-order";
import { dispatchPending } from "@/lib/webhook-outbox";

export const dynamic = "force-dynamic";

const BATCH = 100;
const MISSING_AFTER_MIN = 30;

async function run() {
  // Ask every 15s for the first half hour (IMPS/UPI usually settle in seconds), then every
  // 10 minutes (NEFT batches, bank retries) for up to a week.
  const due = await rows<ProviderPayoutOrder & { submitted_at: Date }>("fifo", `
    SELECT ${PROVIDER_ORDER_COLS}, submitted_at
      FROM fifo_orders
     WHERE provider IS NOT NULL AND direction = 'PAYOUT' AND status = 'SUBMITTED'
       AND submitted_at < now() - interval '5 seconds'
       AND submitted_at >= now() - interval '7 days'
       AND (provider_checked_at IS NULL
            OR provider_checked_at < now() - CASE
                 WHEN submitted_at >= now() - interval '30 minutes' THEN interval '15 seconds'
                 ELSE interval '10 minutes' END)
     ORDER BY submitted_at ASC
     LIMIT ${BATCH}
  `).catch(() => []);

  const counts: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  let flagged = 0;
  for (const o of due) {
    const r = await syncProviderPayout(o, { minGapSeconds: 5 });
    counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
    if (r.outcome === "unknown" && r.detail) {
      const why = `${o.provider}: ${r.detail}`.slice(0, 80);
      reasons[why] = (reasons[why] ?? 0) + 1;
    }
    if (r.outcome === "not_found" && new Date(o.submitted_at).getTime() < Date.now() - MISSING_AFTER_MIN * 60_000) {
      await flagPayoutMissingAtProvider(o);
      flagged++;
    }
  }
  // Merchant callbacks that failed earlier are due again on the outbox schedule
  // (1m, 5m, 15m, 1h, 6h, 24h). Nothing else runs these retries on a timer.
  const callbacks = await dispatchPending({ limit: 50 }).catch(() => null);
  return { checked: due.length, ...counts, flagged_missing: flagged, unknown_reasons: reasons, callbacks };
}

// Whitelisted in middleware (PUBLIC_API), so it carries its own auth like the other crons.
function guard(req: Request) {
  const key = process.env.FIFO_CRON_KEY;
  if (!key) return NextResponse.json({ error: "cron disabled (FIFO_CRON_KEY unset)" }, { status: 503 });
  if (req.headers.get("x-cron-key") !== key) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return null;
}

export async function GET(req: Request) {
  return guard(req) ?? NextResponse.json({ ok: true, ...(await run()) });
}
export async function POST(req: Request) {
  return guard(req) ?? NextResponse.json({ ok: true, ...(await run()) });
}
