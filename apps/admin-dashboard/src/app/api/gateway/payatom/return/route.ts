// GET|POST /api/gateway/payatom/return — the customer's browser back from PayAtom (the redirect_url
// sent with Intent / P2C orders). Katana asks PayAtom what happened, then sends the customer on.
import { handlePayinReturn } from "@/lib/gateway-payin-routes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handlePayinReturn(req, "PAYATOM");
}
export async function POST(req: Request) {
  return handlePayinReturn(req, "PAYATOM");
}
