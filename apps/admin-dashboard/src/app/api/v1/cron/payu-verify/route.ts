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

  let confirmed = 0, failed = 0, stillPending = 0, unreachable = 0, noCreds = 0;

  for (const o of pending) {
    const mid = await getGatewayMid(o.merchant_id);
    // No stored key+salt means we cannot authenticate a verify call for this merchant.
    // Leave the order pending — guessing would be worse than not knowing.
    if (!mid || mid.gateway !== "PAYU") { noCreds++; continue; }

    const v = await verifyPayuTxn(mid, o.txn_id);
    if (!v.found) { unreachable++; continue; }

    const r = await applyVerifiedPayuStatus({
      txnid: o.txn_id, payuStatus: v.status, mihpayid: v.mihpayid, bankRefNum: v.bankRefNum,
    });
    if (r.applied && r.status === "SUCCESS") confirmed++;
    else if (r.applied && r.status === "FAILED") failed++;
    else stillPending++;
  }

  return { checked: pending.length, confirmed, failed, still_pending: stillPending, unreachable, no_creds: noCreds };
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
