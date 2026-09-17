// POST /api/gateway/ccavenue/webhook — CCAvenue's server-to-server notification (encResp form).
// The encrypted response names the order; CCAvenue's order status API decides the outcome.
import { handlePayinWebhook } from "@/lib/gateway-payin-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handlePayinWebhook(req, {
    provider: "CCAVENUE",
    // The plain orderNo CCAvenue posts alongside encResp is enough to find the order.
    txnidOf: (b) => String(b.form?.orderNo ?? b.form?.order_id ?? ""),
    verify: () => null,
  });
}

export async function GET() {
  return Response.json({ ok: true });
}
