// POST /api/gateway/paytm/webhook — Paytm payment notifications (form posts with CHECKSUMHASH).
// Set in each merchant's Paytm dashboard. A present checksum must match the merchant's key;
// Paytm's order status API decides the outcome.
import { handlePayinWebhook } from "@/lib/gateway-payin-routes";
import { paytmCallbackChecksumOk, paytmCallbackTxnid } from "@/lib/payin-providers/paytm";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handlePayinWebhook(req, {
    provider: "PAYTM",
    txnidOf: (b) => paytmCallbackTxnid(b.json ?? {}),
    verify: (mid, b) => (b.form ? paytmCallbackChecksumOk(mid, b.form) : null),
  });
}

export async function GET() {
  return Response.json({ ok: true });
}
