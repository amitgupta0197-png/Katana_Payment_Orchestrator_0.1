// GET /api/v1/intent/order/{id} — status of one Intent order (lib/flow-order-status).

import { flowOrderStatusGet } from "@/lib/flow-order-status";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return flowOrderStatusGet((await params).id, "INTENT");
}
