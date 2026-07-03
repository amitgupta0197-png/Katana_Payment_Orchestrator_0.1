// GET /api/merchants/[id]/devices — the forwarder (Android agent) devices enrolled
// for this merchant, with their reported permission state (notification access),
// trust status, and heartbeat liveness. Backs the merchant dashboard's "Transaction
// agent & permissions" card. SUPER_ADMIN / PROVIDER (scoped) / MERCHANT (own).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";

export const dynamic = "force-dynamic";

// Heartbeat fresher than this = "online".
const ONLINE_WINDOW_SEC = 600;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;

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
    `, [scope.code, String(ONLINE_WINDOW_SEC)]).catch(() => []);

    // A device is "fully permitted" when it's trusted, the agent reports notification
    // access granted + enabled, and it's currently online.
    const shaped = devices.map((d: any) => ({
      ...d,
      permitted: d.status === "TRUSTED" && d.notif_access === true && d.agent_enabled !== false && d.online === true,
    }));
    const anyPermitted = shaped.some((d: any) => d.permitted);

    // Connected email inboxes (Gmail OAuth / app-password) for this merchant — the
    // server-side capture channel that needs no phone.
    const inboxes = await rows<any>("vendorGateway", `
      SELECT email, auth_type, enabled, status, last_polled_at,
             (last_polled_at IS NOT NULL AND last_polled_at >= now() - interval '15 minutes') AS polled_recently
        FROM vendor_email_inboxes
       WHERE merchant_id = $1 AND enabled = true
       ORDER BY updated_at DESC
    `, [scope.code]).catch(() => []);

    return NextResponse.json({ merchant_code: scope.code, devices: shaped, any_permitted: anyPermitted, inboxes });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

// DELETE /api/merchants/[id]/devices?device_id=… — remove an enrolled forwarder
// device (e.g. the merchant uninstalled the app). Uninstalling sends no signal to
// the server, so this lets ops/merchant drop a stale device immediately. If the app
// is still installed it would simply re-enrol on its next heartbeat.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;

  const url = new URL(req.url);
  const deviceId = url.searchParams.get("device_id");
  const email = url.searchParams.get("email");

  try {
    // Disconnect a connected email inbox.
    if (email) {
      const r = await rows<{ email: string }>("vendorGateway",
        `DELETE FROM vendor_email_inboxes WHERE email = $1 AND merchant_id = $2 RETURNING email`,
        [email.toLowerCase(), scope.code]);
      if (!r.length) return NextResponse.json({ error: "inbox not found for this merchant" }, { status: 404 });
      return NextResponse.json({ removed_email: r[0].email });
    }
    if (!deviceId) return NextResponse.json({ error: "device_id or email required" }, { status: 400 });
    const r = await rows<{ device_id: string }>("vendorGateway",
      `DELETE FROM vendor_devices WHERE device_id = $1 AND merchant_id = $2 RETURNING device_id`,
      [deviceId, scope.code]);
    if (!r.length) return NextResponse.json({ error: "device not found for this merchant" }, { status: 404 });
    return NextResponse.json({ removed: r[0].device_id });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
