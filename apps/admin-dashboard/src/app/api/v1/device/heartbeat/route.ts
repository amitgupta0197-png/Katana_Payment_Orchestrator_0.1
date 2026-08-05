// POST /api/v1/device/heartbeat — forwarder device liveness ping (architecture §5,
// §8 "heartbeat every 1–5 minutes"). Updates last_heartbeat and detects SIM changes
// (a forensic signal for SIM-swap, architecture §7) → raises a SECURITY_ALERT.
//
// Public route (device); sandbox bypass or HMAC like the alert ingestion.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { verifyDeviceRequest } from "@/lib/device-auth";

export const dynamic = "force-dynamic";

const schema = z.object({
  device_id: z.string().min(1).max(120),
  merchant_id: z.string().max(120).optional(),
  label: z.string().max(80).optional(),     // phone make/model, for the device list
  sim_id: z.string().max(120).optional(),
  app_hash: z.string().max(128).optional(),
  app_version: z.string().max(40).optional(),
  notif_access: z.boolean().optional(),   // device-reported: notification access granted
  // Payment apps this phone has capture engines enabled for. Empty string = none selected,
  // which means on-screen RRN capture is PAUSED on the device — the difference between a
  // phone that can return an RRN and one that never will.
  capture_apps: z.string().max(200).optional(),
  // Hands-free capture armed. "Get RRN" is a no-op on the device without it.
  auto_capture: z.boolean().optional(),
  agent_enabled: z.boolean().optional(),  // device-reported: forwarding enabled
});

export async function POST(req: Request) {
  const rawText = await req.text();
  const auth = verifyDeviceRequest(req, rawText);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  let body; try { body = schema.parse(JSON.parse(rawText)); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  // Which public domain this device actually contacted (nginx forwards the original
  // Host). Recorded per-device so the glhouse.shop -> katanapay.co migration can be
  // tracked: a device still seen on glhouse.shop is on a pre-cutover build. See the
  // /api/v1/recon/legacy-domain report.
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "")
    .split(",")[0].trim().split(":")[0].toLowerCase() || null;

  try {
    const prev = (await rows<{ sim_id: string | null }>("vendorGateway",
      `SELECT sim_id FROM vendor_devices WHERE device_id = $1`, [body.device_id]))[0];

    // SIM-swap forensic signal: a previously-known SIM changed.
    if (body.sim_id && prev?.sim_id && prev.sim_id !== body.sim_id) {
      await rows("vendorGateway", `
        INSERT INTO vendor_security_alerts (device_id, risk_type, severity, detail)
        VALUES ($1,'SIM_CHANGE','HIGH',$2)
      `, [body.device_id, `SIM changed ${prev.sim_id} → ${body.sim_id}`]).catch(() => {});
    }

    await rows("vendorGateway", `
      INSERT INTO vendor_devices (device_id, status, merchant_id, label, sim_id, app_hash, app_version, notif_access, agent_enabled, last_host, capture_apps, auto_capture, last_heartbeat, updated_at)
      VALUES ($1, 'UNKNOWN', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())
      ON CONFLICT (device_id) DO UPDATE SET
        merchant_id = COALESCE($2, vendor_devices.merchant_id),
        label = COALESCE($3, vendor_devices.label),
        sim_id = COALESCE($4, vendor_devices.sim_id),
        app_hash = COALESCE($5, vendor_devices.app_hash),
        app_version = COALESCE($6, vendor_devices.app_version),
        notif_access = COALESCE($7, vendor_devices.notif_access),
        agent_enabled = COALESCE($8, vendor_devices.agent_enabled),
        last_host = COALESCE($9, vendor_devices.last_host),
        -- Not COALESCEd: an empty list is meaningful (capture switched off), so it must be
        -- able to overwrite a previously non-empty value.
        capture_apps = $10,
        auto_capture = $11,
        last_heartbeat = now(), updated_at = now()
    `, [body.device_id, body.merchant_id ?? null, body.label ?? null, body.sim_id ?? null, body.app_hash ?? null,
        body.app_version ?? null, body.notif_access ?? null, body.agent_enabled ?? null, host,
        body.capture_apps ?? null, body.auto_capture ?? null]);

    // Validate the merchant code so the app can confirm it's correct.
    let merchantKnown = false;
    let merchantName: string | null = null;
    if (body.merchant_id) {
      const m = await rows<{ name: string }>("merchant", `
        SELECT COALESCE(NULLIF(brand_name,''), legal_name) AS name
          FROM merchants WHERE merchant_code = $1 OR id::text = $1 LIMIT 1
      `, [body.merchant_id]).catch(() => []);
      if (m.length) { merchantKnown = true; merchantName = m[0].name; }
    }

    return NextResponse.json({ ok: true, merchant_known: merchantKnown, merchant_name: merchantName });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
