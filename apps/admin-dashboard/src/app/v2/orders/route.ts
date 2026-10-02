// POST /v2/orders — create an order (lib/v2-api). Bearer API key, not a session: let through
// by the middleware.
import { v2CreateOrder } from "@/lib/v2-api";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return v2CreateOrder(req);
}
