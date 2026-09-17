// POST /api/gateway/phonepe/webhook — PhonePe order events (checkout.order.completed / failed).
// Set in each merchant's PhonePe dashboard with a username and password; saved in Katana, they
// make unauthenticated events be refused. PhonePe's order status API decides the outcome.
import { handlePayinWebhook } from "@/lib/gateway-payin-routes";
import { phonepeWebhookAuthOk, phonepeWebhookTxnid } from "@/lib/payin-providers/phonepe";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handlePayinWebhook(req, {
    provider: "PHONEPE",
    txnidOf: (b) => phonepeWebhookTxnid(b.json),
    verify: (mid, _b, h) => phonepeWebhookAuthOk(mid, h.get("authorization")),
  });
}

export async function GET() {
  return Response.json({ ok: true });
}
