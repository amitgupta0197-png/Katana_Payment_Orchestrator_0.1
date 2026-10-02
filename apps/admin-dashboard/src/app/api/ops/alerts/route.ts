// GET /api/ops/alerts — the gateway alerts that are open right now (lib/ops-alert), for the
// banner staff see on every page. STAFF ONLY: the titles name gateways.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { STAFF_PERSONAS } from "@/lib/portal-scope";
import { openAlerts } from "@/lib/ops-alert";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(STAFF_PERSONAS);
  if ("response" in g) return g.response;
  const all = await openAlerts();
  return NextResponse.json({ alerts: all.filter((a) => a.alert_key.startsWith("gateway:")).map((a) => ({ key: a.alert_key, severity: a.severity, title: a.title, since: a.first_seen_at })) });
}
