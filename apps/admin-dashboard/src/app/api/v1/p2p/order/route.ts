// POST /api/v1/p2p/order — the Katana P2P pay-in order API (S2S). Same request, signature and
// response as the general order API (lib/katana-order-api); the order is always P2P: a UPI
// link to the banker's own UPI ID, confirmed by a bank credit. Refused for a merchant that is
// not on the P2P flow.
import { katanaOrderPost } from "@/lib/katana-order-api";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return katanaOrderPost(req, { flow: "P2P", where: "api/v1/p2p/order" });
}
