// GET /api/v1/recon/legacy-domain — migration watchdog for the glhouse.shop ->
// katanapay.co domain cutover. Every forwarder device records the public host it last
// contacted on its heartbeat (vendor_devices.last_host). This report groups recently-
// active devices by that host so an admin can see who is still hitting the legacy
// domain and decide when glhouse.shop can be retired.
//
// `safe_to_retire` is true when no device has contacted glhouse.shop within the window
// — i.e. every live agent has moved to katanapay.co (or a custom URL). Admin-gated.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const LEGACY_DOMAIN = "glhouse.shop";
const CUTOVER_DOMAIN = "katanapay.co";
const ROLES = ["SUPER_ADMIN", "ADMIN", "RISK"] as const;

export async function GET(req: Request) {
  const g = await gateOrResponse([...ROLES]);
  if ("response" in g) return g.response;

  // Only count devices seen recently — a phone that last checked in months ago on the
  // old domain shouldn't block retiring it forever. Default 7 days, ?days= to override.
  const days = Math.min(90, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 7));

  try {
    // Count of recently-active devices per host (null host bucketed as 'unknown').
    const counts = await rows<{ host: string; devices: number }>("vendorGateway", `
      SELECT COALESCE(NULLIF(last_host,''), 'unknown') AS host, COUNT(*)::int AS devices
        FROM vendor_devices
       WHERE last_heartbeat > now() - ($1 || ' days')::interval
       GROUP BY 1 ORDER BY devices DESC
    `, [String(days)]).catch(() => []);

    // The stragglers: recently-active devices still on the legacy domain.
    const legacy = await rows<any>("vendorGateway", `
      SELECT device_id, COALESCE(label,'') AS label, COALESCE(merchant_id,'') AS merchant_id,
             COALESCE(app_version,'') AS app_version, last_host, last_heartbeat
        FROM vendor_devices
       WHERE last_host = $1
         AND last_heartbeat > now() - ($2 || ' days')::interval
       ORDER BY last_heartbeat DESC LIMIT 500
    `, [LEGACY_DOMAIN, String(days)]).catch(() => []);

    const summary: Record<string, number> = {};
    for (const c of counts) summary[c.host] = c.devices;

    return NextResponse.json({
      legacy_domain: LEGACY_DOMAIN,
      cutover_domain: CUTOVER_DOMAIN,
      window_days: days,
      summary,                                  // { "katanapay.co": N, "glhouse.shop": M, "unknown": K }
      legacy_active_count: legacy.length,
      legacy_active: legacy,                    // devices to update before retiring glhouse.shop
      safe_to_retire: legacy.length === 0,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
