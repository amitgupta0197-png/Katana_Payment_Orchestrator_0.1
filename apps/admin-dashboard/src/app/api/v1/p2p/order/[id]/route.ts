// GET /api/v1/p2p/order/{id} — status of one P2P order (lib/flow-order-status).

import { flowOrderStatusGet } from "@/lib/flow-order-status";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return flowOrderStatusGet((await params).id, "P2P");
}
