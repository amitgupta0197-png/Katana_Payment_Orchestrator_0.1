// The partner API: onboard and list sub-merchants (lib/partner/api).
import { partnerCreateSub, partnerListSubs } from "@/lib/partner/api";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => partnerCreateSub(req);
export const GET = (req: Request) => partnerListSubs(req);
