// GET /api/merchant-portal/agent — the logged-in MERCHANT's own forwarder devices +
// permission state, for the merchant portal's "Transaction agent" card (download +
// status). Self-scoped: the merchant_code comes from the session, so a merchant only
// ever sees their own devices.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";
const ONLINE_WINDOW_SEC = 600;

export async function GET() {
  const g = await gateOrResponse(["MERCHANT", "SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const merchantCode = g.session.scope_id ?? "";
  if (!merchantCode) return NextResponse.json({ merchant_code: "", devices: [], any_permitted: false });

  try {
    const devices = await rows<any>("vendorGateway", `
      SELECT device_id, COALESCE(label,'') AS label, status,
             notif_access, agent_enabled, COALESCE(app_version,'') AS app_version,
             last_heartbeat,
             (last_heartbeat IS NOT NULL AND last_heartbeat >= now() - ($2 || ' seconds')::interval) AS online,
             created_at
        FROM vendor_devices
       WHERE merchant_id = $1
       ORDER BY (status='TRUSTED') DESC, updated_at DESC
    `, [merchantCode, String(ONLINE_WINDOW_SEC)]).catch(() => []);

    const shaped = devices.map((d: any) => ({
      ...d,
      permitted: d.status === "TRUSTED" && d.notif_access === true && d.agent_enabled !== false && d.online === true,
    }));
    return NextResponse.json({
      merchant_code: merchantCode,
      devices: shaped,
      any_permitted: shaped.some((d: any) => d.permitted),
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
