// POST /api/gateway/poolpay/payout-webhook — PoolPay payout call-backs (any status change).
// Set as the call-back URL in each merchant's PoolPay portal; PoolPay only calls whitelisted
// endpoints. The body is only a hint: PoolPay's enquiry API decides (lib/provider-payout-webhook).
import { NextResponse } from "next/server";
import { poolpayCallbackRef } from "@/lib/payout-providers/poolpay";
import { handleProviderPayoutWebhook, readWebhookBody } from "@/lib/provider-payout-webhook";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { json: body } = await readWebhookBody(req);
  if (!body) return NextResponse.json({ ok: false, error: "empty body" }, { status: 400 });
  const { ref, event } = poolpayCallbackRef(body);
  return handleProviderPayoutWebhook({
    provider: "POOLPAY",
    ref,
    providerRef: body.transaction_id ? String(body.transaction_id) : null,
    event,
    // PoolPay's call-back hash can't be checked reliably from its doc; the enquiry is the check.
    verify: () => null,
  });
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
