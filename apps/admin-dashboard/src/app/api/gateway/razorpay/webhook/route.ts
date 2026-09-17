// POST /api/gateway/razorpay/webhook — Razorpay payment events (order.paid, payment.failed).
// Set in each merchant's Razorpay dashboard with the webhook secret saved in Katana. With a
// secret saved, unsigned or wrongly signed events are refused; either way Razorpay's own order
// API decides the outcome (lib/gateway-payin).
import { handlePayinWebhook } from "@/lib/gateway-payin-routes";
import { razorpaySignatureOk, razorpayWebhookTxnid } from "@/lib/payin-providers/razorpay";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handlePayinWebhook(req, {
    provider: "RAZORPAY",
    txnidOf: (b) => razorpayWebhookTxnid(b.json),
    verify: (mid, b, h) => (mid.extra?.webhook_secret ? razorpaySignatureOk(mid.extra.webhook_secret, b.raw, h.get("x-razorpay-signature")) : null),
  });
}

export async function GET() {
  return Response.json({ ok: true });
}
