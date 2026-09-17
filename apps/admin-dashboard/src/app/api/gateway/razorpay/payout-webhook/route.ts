// POST /api/gateway/razorpay/payout-webhook — RazorpayX payout events (payout.processed,
// payout.reversed, payout.failed, payout.rejected, payout.updated, ...). One URL for every
// merchant, set in each merchant's RazorpayX dashboard with a webhook secret.
//
// RazorpayX signs the raw body (X-Razorpay-Signature). With the merchant's webhook secret saved
// in Katana, an unsigned or wrongly signed event is refused. Either way the body is only a hint:
// RazorpayX's payout API decides (lib/provider-payout-webhook).
import { NextResponse } from "next/server";
import { razorpayWebhookSignatureOk, type RazorpayPayoutCreds } from "@/lib/payout-providers/razorpay";
import { handleProviderPayoutWebhook, readWebhookBody } from "@/lib/provider-payout-webhook";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { raw, json: body } = await readWebhookBody(req);
  if (!body) return NextResponse.json({ ok: false, error: "empty body" }, { status: 400 });
  const payout = body?.payload?.payout?.entity ?? {};
  const sig = req.headers.get("x-razorpay-signature");
  return handleProviderPayoutWebhook({
    provider: "RAZORPAY",
    ref: String(payout.reference_id ?? ""),
    providerRef: payout.id ? String(payout.id) : null,
    event: String(body.event ?? "").toUpperCase(),
    verify: ({ creds }) => {
      const c = creds as RazorpayPayoutCreds;
      return c.webhook_secret ? razorpayWebhookSignatureOk(c, raw, sig) : null;
    },
  });
}

export async function GET() {
  return NextResponse.json({ ok: true });
}
