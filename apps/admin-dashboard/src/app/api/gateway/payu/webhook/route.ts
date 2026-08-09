// POST /api/gateway/payu/webhook — PayU server-to-server webhook.
//
// This is the URL a merchant pastes into PayU Dashboard → Webhooks (Type: Payments,
// Event: Successful). ONE URL SERVES EVERY MERCHANT: the merchant is resolved from the
// payload (txnid → checkout_orders → merchant_id), then the response hash is verified
// with that merchant's own stored PayU salt.
//
// Why this exists alongside /api/gateway/payu/return: that route is PayU's surl/furl and
// must reply with a REDIRECT to send the shopper back to the merchant's page. A webhook
// caller wants a 2xx — given a 3xx, PayU marks delivery failed and retries the event.
// Same verification (shared in lib/payu-result), different reply.
//
// The webhook is the reliable channel: a shopper who closes the tab after paying never
// triggers the browser redirect, and without this the payment would sit unconfirmed.
//
// Public route (allow-listed in middleware) — authenticated by PayU's response hash, not
// by a session. An unsigned or mis-signed payload is recorded as FAILED, never SUCCESS.

import { NextResponse } from "next/server";
import { applyPayuResult, parsePayuBody } from "@/lib/payu-result";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let p: Record<string, string>;
  try { p = await parsePayuBody(req); }
  catch { return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 }); }

  const r = await applyPayuResult(p);

  // Always 200 once the payload is readable, including for an unknown txnid. PayU retries
  // non-2xx, and retrying an order we do not have will never start working — it would just
  // fill their dashboard with permanent failures. The body says what happened.
  return NextResponse.json({
    ok: true,
    txn_id: r.txnid || null,
    matched: r.matched,
    status: r.status,
    hash_verified: r.hashOk,
    applied: r.applied,          // false = already finalised by the browser redirect
    ...(r.reason ? { note: r.reason } : {}),
  });
}

// PayU sends a GET when you use "Test" in the dashboard; answer 200 so the check passes.
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "payu-webhook", method: "POST" });
}
