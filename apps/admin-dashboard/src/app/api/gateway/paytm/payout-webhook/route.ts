// POST /api/gateway/paytm/payout-webhook — Paytm Payouts callbacks. Katana sends this URL as
// the callbackUrl on every Paytm transfer, so there is nothing to set in Paytm's dashboard.
//
// If Paytm sends a checksum (x-checksum) it must match the merchant's key. Either way the body
// is only a hint: Paytm's order status API decides (lib/provider-payout-webhook).
import { NextResponse } from "next/server";
import { paytmChecksumOk, paytmWebhookRef, type PaytmPayoutCreds } from "@/lib/payout-providers/paytm";
import { handleProviderPayoutWebhook, readWebhookBody } from "@/lib/provider-payout-webhook";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { raw, json: body } = await readWebhookBody(req);
  if (!body) return NextResponse.json({ ok: false, error: "empty body" }, { status: 400 });
  const { ref, event } = paytmWebhookRef(body);
  const checksum = req.headers.get("x-checksum");
  return handleProviderPayoutWebhook({
    provider: "PAYTM",
    ref,
    event,
    verify: ({ creds }) => (checksum ? paytmChecksumOk(raw, (creds as PaytmPayoutCreds).merchant_key, checksum) : null),
  });
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
