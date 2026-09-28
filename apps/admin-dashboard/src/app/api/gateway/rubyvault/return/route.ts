// GET|POST /api/gateway/rubyvault/return — the customer's browser back from RubyVault, when
// RubyVault sends it back. Katana asks RubyVault what happened, then sends the customer on.
import { handlePayinReturn } from "@/lib/gateway-payin-routes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handlePayinReturn(req, "RUBYVAULT");
}
export async function POST(req: Request) {
  return handlePayinReturn(req, "RUBYVAULT");
}
