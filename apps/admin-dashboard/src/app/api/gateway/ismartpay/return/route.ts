// GET|POST /api/gateway/ismartpay/return — the customer's browser back from iSmartPay (the
// redirect_url Katana sends with each order). Katana asks iSmartPay what happened, then sends
// the customer on.
import { handlePayinReturn } from "@/lib/gateway-payin-routes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handlePayinReturn(req, "ISMARTPAY");
}
export async function POST(req: Request) {
  return handlePayinReturn(req, "ISMARTPAY");
}
