// POST /api/gateway/cashfree/payout-webhook — Cashfree Payouts events (TRANSFER_SUCCESS,
// TRANSFER_FAILED, TRANSFER_REVERSED, TRANSFER_REJECTED, ...). One URL for every merchant, set
// in each merchant's Cashfree Payouts dashboard.
//
// Cashfree signs every event with the merchant's Payouts client secret, which Katana already
// holds, so an unsigned or wrongly signed event is always refused. The body is still only a
// hint: Cashfree's transfer status API decides (lib/provider-payout-webhook).
import { NextResponse } from "next/server";
import { cashfreeWebhookRef, cashfreeWebhookSignatureOk, type CashfreePayoutCreds } from "@/lib/payout-providers/cashfree";
import { handleProviderPayoutWebhook, readWebhookBody } from "@/lib/provider-payout-webhook";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { raw, json: body, form } = await readWebhookBody(req);
  if (!body) return NextResponse.json({ ok: false, error: "empty body" }, { status: 400 });
  const { ref, event } = cashfreeWebhookRef(body);
  return handleProviderPayoutWebhook({
    provider: "CASHFREE",
    ref,
    providerRef: body?.data?.cf_transfer_id != null ? String(body.data.cf_transfer_id) : null,
    event,
    verify: ({ creds }) => cashfreeWebhookSignatureOk(creds as CashfreePayoutCreds, raw, req.headers, form),
  });
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
