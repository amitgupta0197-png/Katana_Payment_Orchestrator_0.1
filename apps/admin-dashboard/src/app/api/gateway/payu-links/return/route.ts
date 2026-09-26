// GET|POST /api/gateway/payu-links/return — the customer's browser back from a PayU payment link
// (PayU with a Client ID + Secret). PayU's Payment Links API says what happened, then the
// customer is sent on. A PayU Key + Salt merchant returns to /api/gateway/payu/return instead.
import { handlePayinReturn } from "@/lib/gateway-payin-routes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handlePayinReturn(req, "PAYU");
}
export async function POST(req: Request) {
  return handlePayinReturn(req, "PAYU");
}
