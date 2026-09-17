// POST /api/gateway/cashfree/webhook — Cashfree payment events. Katana also sends this URL as
// each order's notify_url. Cashfree signs every event with the merchant's Secret Key, so an
// unsigned or wrongly signed event is refused; Cashfree's order API decides the outcome.
import { handlePayinWebhook } from "@/lib/gateway-payin-routes";
import { cashfreePayinSignatureOk, cashfreePayinWebhookTxnid } from "@/lib/payin-providers/cashfree";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handlePayinWebhook(req, {
    provider: "CASHFREE",
    txnidOf: (b) => cashfreePayinWebhookTxnid(b.json),
    verify: (mid, b, h) => cashfreePayinSignatureOk(mid.salt, b.raw, h),
  });
}

export async function GET() {
  return Response.json({ ok: true });
}
