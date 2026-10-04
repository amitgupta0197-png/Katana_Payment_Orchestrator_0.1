// GET /api/flows/intent — everything the /flows/intent dashboard shows (lib/flow-dashboards-store). STAFF ONLY, read-only.
import { flowRoute } from "@/lib/flow-dashboards-route";
import { intentDashboard } from "@/lib/flow-dashboards-store";

export const dynamic = "force-dynamic";
export const GET = flowRoute(intentDashboard);
