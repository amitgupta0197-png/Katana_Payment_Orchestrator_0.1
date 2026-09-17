// GET|POST /api/gateway/cashfree/return — the customer's browser back from the gateway. Katana asks
// the gateway what happened (lib/gateway-payin), then sends the customer on to the merchant.
import { handlePayinReturn } from "@/lib/gateway-payin-routes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handlePayinReturn(req, "CASHFREE");
}
export async function POST(req: Request) {
  return handlePayinReturn(req, "CASHFREE");
}
