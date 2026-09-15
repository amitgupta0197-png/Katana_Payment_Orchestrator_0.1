// GET/POST /api/v1/cron/payu-verify — reconcile PayU payments we never heard back about.
//
// With UPI (Intent or Collect) the customer approves inside their UPI app and usually does
// NOT return to the browser, so surl/furl never fires. The webhook can also be lost — a
// blip, a wrong dashboard URL, a non-2xx reply. Left alone, a real payment sits PENDING
// forever: the customer paid and the merchant never got credited.
//
// This sweep asks PayU directly (Verify Payment API) about every order still pending, and
// finalises the ones PayU says are done. It is the safety net that makes the integration
// trustworthy rather than hopeful.
//
// Safe to run often and to overlap with the callbacks: applyVerifiedPayuStatus shares the
// "already final" guard, so an order confirmed by the webhook a second earlier is left
// untouched and reported as skipped.
import { NextResponse } from "next/server";
import { rows } from "@/lib/pg";
import { getGatewayMid } from "@/lib/gateway-creds";
import { verifyPayuTxn } from "@/lib/payu-verify";
import { applyVerifiedPayuStatus } from "@/lib/payu-result";

export const dynamic = "force-dynamic";

// Give the normal channels a moment before second-guessing them, and don't chase orders
// so old the customer has long gone.
const MIN_AGE_MIN = 2;
const MAX_AGE_HOURS = 48;
const BATCH = 100;

// Stamp a PayU pay-in with when we last asked PayU, and with PayU's answer once it is a definite
// failure, so the sweep's back-off and stop conditions above can see it.
async function markPayinChecked(txnid: string, payuStatus: string | null): Promise<void> {
  const patch: Record<string, string> = { checked_at: new Date().toISOString() };
  if (payuStatus === "failure" || payuStatus === "failed") patch.final = payuStatus;
  await rows("vendorGateway", `
    UPDATE vendor_payin_orders
       SET meta = jsonb_set(meta, '{gateway}', COALESCE(meta->'gateway', '{}'::jsonb) || $2::jsonb)
     WHERE vendor = 'POOLPAY' AND vendor_txn_id = $1 AND meta->'gateway'->>'provider' = 'PAYU'
  `, [txnid, JSON.stringify(patch)]).catch(() => {});
}

async function run() {
  const pending = await rows<{ txn_id: string; merchant_id: string }>("checkout", `
    SELECT txn_id, merchant_id
      FROM checkout_orders
     WHERE status NOT IN ('SUCCESS','FAILED')
       AND txn_id IS NOT NULL
       AND created_at <  now() - ($1 || ' minutes')::interval
       AND created_at >= now() - ($2 || ' hours')::interval
     ORDER BY created_at DESC
     LIMIT ${BATCH}
  `, [String(MIN_AGE_MIN), String(MAX_AGE_HOURS)]).catch(() => []);

  // PayU pay-ins from the Katana Pay order flow (vendor_payin_orders, keyed by the PayU txnid).
  // EXPIRED is included on purpose: the pay page stops waiting after 15 minutes, but a customer
  // who approved late has still paid, and confirmPoolPayOrder revives an expired order on success.
  const payins = await rows<{ txn_id: string; merchant_id: string }>("vendorGateway", `
    SELECT vendor_txn_id AS txn_id, merchant_id
      FROM vendor_payin_orders
     WHERE vendor = 'POOLPAY' AND meta->'gateway'->>'provider' = 'PAYU'
       AND status NOT IN ('SUCCESS','SUCCEEDED','FAILED')
       AND livemode = true
       AND created_at <  now() - ($1 || ' minutes')::interval
       AND created_at >= now() - ($2 || ' hours')::interval
       -- PayU already answered failure: an EXPIRED order cannot be moved to FAILED, so without
       -- this it would be asked about again on every run for 48 hours.
       AND COALESCE(meta->'gateway'->>'final', '') = ''
       -- This sweep runs every 15s. Ask every 30s while the customer is likely still in their
       -- UPI app, then every 10 minutes, so abandoned intents don't hammer PayU's verify API.
       AND (meta->'gateway'->>'checked_at' IS NULL
            OR (meta->'gateway'->>'checked_at')::timestamptz < now() - CASE
                 WHEN created_at >= now() - interval '30 minutes' THEN interval '30 seconds'
                 ELSE interval '10 minutes' END)
     ORDER BY created_at DESC
     LIMIT ${BATCH}
  `, [String(MIN_AGE_MIN), String(MAX_AGE_HOURS)]).catch(() => []);

  let confirmed = 0, failed = 0, stillPending = 0, unreachable = 0, noCreds = 0;

  const checks = [
    ...pending.map((o) => ({ ...o, payin: false })),
    ...payins.map((o) => ({ ...o, payin: true })),
  ];
  for (const o of checks) {
    const mid = await getGatewayMid(o.merchant_id);
    // No stored key+salt means we cannot authenticate a verify call for this merchant.
    // Leave the order pending — guessing would be worse than not knowing.
    if (!mid || mid.gateway !== "PAYU") { noCreds++; continue; }

    const v = await verifyPayuTxn(mid, o.txn_id);
    if (o.payin) await markPayinChecked(o.txn_id, v.found ? v.status : null);
    if (!v.found) { unreachable++; continue; }

    const r = await applyVerifiedPayuStatus({
      txnid: o.txn_id, payuStatus: v.status, mihpayid: v.mihpayid, bankRefNum: v.bankRefNum,
      raw: v.raw,
    });
    if (r.applied && r.status === "SUCCESS") confirmed++;
    else if (r.applied && r.status === "FAILED") failed++;
    else stillPending++;
  }

  return { checked: pending.length + payins.length, confirmed, failed, still_pending: stillPending, unreachable, no_creds: noCreds };
}

// Whitelisted in middleware (PUBLIC_API), so it carries its own auth like the other crons.
// Without this any caller could make us fire up to BATCH outbound Verify calls per request.
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
