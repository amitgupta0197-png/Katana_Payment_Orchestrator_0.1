// GET|POST /api/gateway/poolpay/return — the customer's browser back from PoolPay (PoolPay also
// posts its result here). Katana asks PoolPay what happened, then sends the customer on.
import { handlePayinReturn } from "@/lib/gateway-payin-routes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handlePayinReturn(req, "POOLPAY");
}
export async function POST(req: Request) {
  return handlePayinReturn(req, "POOLPAY");
}
