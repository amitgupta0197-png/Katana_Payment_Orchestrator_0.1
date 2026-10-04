// GET /api/flows/health — everything the /flows/health dashboard shows (lib/flow-dashboards-health). STAFF ONLY, read-only.
import { flowRoute } from "@/lib/flow-dashboards-route";
import { healthGrid } from "@/lib/flow-dashboards-health";

export const dynamic = "force-dynamic";
export const GET = flowRoute(healthGrid);
