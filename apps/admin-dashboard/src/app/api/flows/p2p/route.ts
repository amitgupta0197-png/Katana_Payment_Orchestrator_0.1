// GET /api/flows/p2p — everything the /flows/p2p dashboard shows (lib/flow-dashboards-p2p). STAFF ONLY, read-only.
import { flowRoute } from "@/lib/flow-dashboards-route";
import { p2pDashboard } from "@/lib/flow-dashboards-p2p";

export const dynamic = "force-dynamic";
export const GET = flowRoute(p2pDashboard);
