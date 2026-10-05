// The partner API: one order, by Katana's id (KTN_…) or the partner's reference (lib/partner/api).
import { partnerGetOrder } from "@/lib/partner/api";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return partnerGetOrder(req, decodeURIComponent((await params).id));
}
