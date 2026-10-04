// GET /api/flows/payout — everything the /flows/payout dashboard shows (lib/flow-dashboards-payout). STAFF ONLY, read-only.
import { flowRoute } from "@/lib/flow-dashboards-route";
import { payoutDashboard } from "@/lib/flow-dashboards-payout";

export const dynamic = "force-dynamic";
export const GET = flowRoute(payoutDashboard);
