// POST /api/v1/katana-pay/order — the general Katana pay-in order API (S2S), authenticated by
// the merchant's Key + Salt (not a session; allow-listed in middleware). The merchant's
// selected pay-in flow decides whether the order goes P2P or Intent (lib/payin-flow).
// Request, signature and response: lib/katana-order-api.
import { katanaOrderPost } from "@/lib/katana-order-api";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return katanaOrderPost(req, { flow: null, where: "api/v1/katana-pay/order" });
}
