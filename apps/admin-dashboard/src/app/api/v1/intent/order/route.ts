// POST /api/v1/intent/order — the Katana Intent pay-in order API (S2S). Same request, signature
// and response as the general order API (lib/katana-order-api); the order is always Intent: a
// payment gateway issues and confirms the payment. Refused for a merchant that is not on the
// Intent flow.
import { katanaOrderPost } from "@/lib/katana-order-api";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return katanaOrderPost(req, { flow: "INTENT", where: "api/v1/intent/order" });
}
