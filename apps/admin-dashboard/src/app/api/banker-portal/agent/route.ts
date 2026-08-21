// GET /api/banker-portal/agent — the logged-in MERCHANT's own forwarder devices +
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
             COALESCE(capture_apps,'') AS capture_apps,
             auto_capture, counters, keep_awake, overlay_ok, charging,
             last_heartbeat,
             (last_heartbeat IS NOT NULL AND last_heartbeat >= now() - ($2 || ' seconds')::interval) AS online,
             created_at
        FROM vendor_devices
       WHERE merchant_id = $1
       ORDER BY (status='TRUSTED') DESC, updated_at DESC
    `, [merchantCode, String(ONLINE_WINDOW_SEC)]).catch(() => []);

    // DEVICE ID SHARED WITH ANOTHER PHONE. An id typed the same on two phones means one
    // vendor_devices row and one banker binding, and the phone that loses it goes dark while
    // its card still reads "online · ready" — the state AVTS23 was left in for a day on
    // 2026-08-20. The heartbeat raises DEVICE_ID_CONFLICT when the binding oscillates
    // (migration 0020); surfacing it here is what makes it visible to the person affected.
    const conflicts = new Set((await rows<{ device_id: string }>("vendorGateway", `
      SELECT DISTINCT device_id FROM vendor_security_alerts
       WHERE risk_type = 'DEVICE_ID_CONFLICT' AND status = 'OPEN'
         AND created_at > now() - interval '7 days'
    `).catch(() => [])).map((r) => r.device_id));

    const shaped = devices.map((d: any) => ({
      ...d,
      id_conflict: conflicts.has(d.device_id),
      permitted: d.status === "TRUSTED" && d.notif_access === true && d.agent_enabled !== false && d.online === true,
      // On-screen RRN capture is paused on the device until a payment app is selected, so a
      // phone can be fully "permitted" and still never return an RRN. Surface that
      // separately rather than folding it into `permitted`, which gates alert forwarding.
      rrn_capture_ready: (d.capture_apps ?? "").trim().length > 0 && d.auto_capture === true,
      // WILL THIS PHONE'S SCREEN STAY ON? On-screen capture needs a live display, so a phone
      // that sleeps captures nothing — yet heartbeats, notification access and auto-capture all
      // stay green, which is exactly how a capture phone reads "online · ready" while being
      // deaf. Reported only once the device is on an agent that sends the fields; older builds
      // send neither, and a phone we cannot ask about must not be flagged as broken.
      screen_state: d.keep_awake == null && d.overlay_ok == null
        ? "unknown"
        : d.keep_awake !== true ? "may_sleep"
        : d.overlay_ok !== true ? "overlay_missing"
        : d.charging === false ? "unplugged"
        : "stays_awake",
    }));
    // Notification formats this phone saw, recognised as money, and could not parse. These
    // are the payments being lost — each distinct sample is a parser fix.
    const unparsed = await rows<{ body: string; created_at: string }>("vendorGateway", `
      SELECT body, created_at FROM vendor_agent_debug
       WHERE merchant_id = $1 AND label = 'unparsed'
       ORDER BY created_at DESC LIMIT 10
    `, [merchantCode]).catch(() => []);

    return NextResponse.json({
      merchant_code: merchantCode,
      devices: shaped,
      any_permitted: shaped.some((d: any) => d.permitted),
      unparsed,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
