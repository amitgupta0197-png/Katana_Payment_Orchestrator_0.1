// The partner API: one sub-merchant, by Katana's id (SM_…) or the partner's external_id (lib/partner/api).
import { partnerGetSub, partnerUpdateSub } from "@/lib/partner/api";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return partnerGetSub(req, decodeURIComponent((await params).id));
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return partnerUpdateSub(req, decodeURIComponent((await params).id));
}
