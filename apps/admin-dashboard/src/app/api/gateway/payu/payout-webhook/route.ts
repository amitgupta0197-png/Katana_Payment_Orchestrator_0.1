// POST /api/gateway/payu/payout-webhook — PayU Payouts events (TRANSFER_SUCCESS / _FAILED /
// _REVERSED, LOW_BALANCE_ALERT, ...). One URL for every merchant; registered per merchant
// from the admin merchant page, which also sets the shared token PayU echoes back.
//
// PayU does not sign these events. Two things stand in for a signature:
//   1. the Authorization header must equal the token registered for that merchant, and
//   2. the body is only a hint: syncPayuPayout asks PayU's status API what happened and
//      applies that. A forged "success" can't mark a payout paid.
//
// PayU wants a 200 within 10 seconds and retries twice otherwise, so the status lookup gets a
// short timeout; if it doesn't answer in time the sweep (cron/payu-payout-verify) finishes the job.
import { NextResponse } from "next/server";
import { getPayuPayoutCreds, payoutWebhookTokenMatches } from "@/lib/payu-payout";
import { loadPayuPayout, syncPayuPayout } from "@/lib/payu-payout-order";

export const dynamic = "force-dynamic";

async function parse(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => "");
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through to form */ }
  const form = Object.fromEntries(new URLSearchParams(text));
  return Object.keys(form).length ? form : null;
}

export async function POST(req: Request) {
  const body = await parse(req);
  if (!body) return NextResponse.json({ ok: false, error: "empty body" }, { status: 400 });

  const event = String(body.event ?? "").toUpperCase();
  const ref = String(body.merchantReferenceId ?? body.merchantRefId ?? "");
  // Account-level events (LOW_BALANCE_ALERT, DEPOSIT_SUCCESS, ...) carry no transfer.
  if (!ref) return NextResponse.json({ ok: true, ignored: "no transfer reference", event });

  const order = await loadPayuPayout("txn_ref", ref);
  if (!order) return NextResponse.json({ ok: true, ignored: "unknown transfer", event });

  const creds = await getPayuPayoutCreds(order.merchant_id);
  if (!creds) return NextResponse.json({ ok: true, ignored: "no PayU payout credentials", event });
  // Until the webhook is registered from Katana there is no token to check; the status
  // lookup below is then the only check, and it is the one that matters.
  if (creds.webhook_token && !payoutWebhookTokenMatches(creds, req.headers.get("authorization")))
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const r = await syncPayuPayout(order, { hint: event, timeoutMs: 6_000, minGapSeconds: 0 });
  return NextResponse.json({ ok: true, event, order_ref: order.order_ref, outcome: r.outcome });
}

// PayU's dashboard pings the URL when you save it.
export async function GET() {
  return NextResponse.json({ ok: true });
}
