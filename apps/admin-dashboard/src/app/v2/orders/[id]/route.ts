// GET /v2/orders/{order_id|reference} — one order, as its webhook states it (lib/v2-api).
import { v2GetOrder } from "@/lib/v2-api";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A reference may hold characters that arrive percent-encoded.
  let ref = id;
  try { ref = decodeURIComponent(id); } catch { /* used as sent */ }
  return v2GetOrder(req, ref);
}
