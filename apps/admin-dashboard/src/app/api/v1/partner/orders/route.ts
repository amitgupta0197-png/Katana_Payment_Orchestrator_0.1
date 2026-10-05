// The partner API: create an order for a sub-merchant (lib/partner/api).
import { partnerCreateOrder } from "@/lib/partner/api";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => partnerCreateOrder(req);
