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
  // Whether this phone's screen will stay on by itself. On-screen capture needs a live
  // display, so a sleeping phone captures nothing at all — and used to report itself
  // perfectly healthy while doing so. `overlay_ok` is the permission that makes
  // `keep_awake` real; either one false and capture depends on the phone being plugged in.
  keep_awake: z.boolean().optional(),
  overlay_ok: z.boolean().optional(),
  charging: z.boolean().optional(),
  // Immutable per-install identity (see migration 0022). Distinguishes a renamed phone from
  // a second phone that typed the same device id.
  install_id: z.string().max(64).optional(),
  parser_version: z.string().max(40).optional(),
  agent_enabled: z.boolean().optional(),  // device-reported: forwarding enabled
}).passthrough();   // ctr_* counters are read off the raw body below

// Capture counters arrive as flat ctr_<name> fields so the agent can add one without a
// schema change on either side. `dropped` is the important one: notifications that looked
// like money and could not be parsed — i.e. payments being seen and lost.
function readCounters(raw: Record<string, unknown>): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("ctr_") && typeof v === "number" && Number.isFinite(v)) {
      out[k.slice(4)] = Math.max(0, Math.trunc(v));
    }
  }
  return Object.keys(out).length ? out : null;
}

export async function POST(req: Request) {
  const rawText = await req.text();
  const auth = verifyDeviceRequest(req, rawText);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  let body; try { body = schema.parse(JSON.parse(rawText)); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const counters = readCounters(body as unknown as Record<string, unknown>);

  // Which public domain this device actually contacted (nginx forwards the original
  // Host). Recorded per-device so the glhouse.shop -> katanapay.co migration can be
  // tracked: a device still seen on glhouse.shop is on a pre-cutover build. See the
  // /api/v1/recon/legacy-domain report.
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "")
    .split(",")[0].trim().split(":")[0].toLowerCase() || null;

  try {
    const prev = (await rows<{
      sim_id: string | null; merchant_id: string | null;
      prev_merchant_id: string | null; merchant_changed_at: string | null; install_id: string | null;
    }>("vendorGateway",
      `SELECT sim_id, merchant_id, prev_merchant_id, merchant_changed_at, install_id
         FROM vendor_devices WHERE device_id = $1`, [body.device_id]))[0];

    // SIM-swap forensic signal: a previously-known SIM changed.
    if (body.sim_id && prev?.sim_id && prev.sim_id !== body.sim_id) {
      await rows("vendorGateway", `
        INSERT INTO vendor_security_alerts (device_id, risk_type, severity, detail)
        VALUES ($1,'SIM_CHANGE','HIGH',$2)
      `, [body.device_id, `SIM changed ${prev.sim_id} → ${body.sim_id}`]).catch(() => {});
    }

    // TWO PHONES ON ONE DEVICE ID (see migration 0020).
    //
    // device_id is user-editable, so nothing stops two phones being typed the same name — and
    // when they are, they share one row and the last heartbeat owns the banker binding. The
    // loser's capture queue is then never polled and its dashboard still reads "online · ready",
    // which is how AVTS23 sat dark through 2026-08-20 with nobody able to see why.
    //
    // A phone that is genuinely re-enrolled changes banker ONCE. Only two phones make the
    // binding oscillate, so a change BACK to the code this id reported before the last change is
    // proof of a second device and is raised HIGH. A change that merely lands within a day of the
    // previous one is suspicious but could be an operator correcting a typo, so it is MEDIUM.
    // TWO PHONES, PROVEN. Same device_id arriving with a different install_id is not a
    // heuristic — install_id is generated on the device and never typed, so it can only differ
    // if a second physical phone is using this name. Reported the moment it happens, rather
    // than waiting for the binding to oscillate the way 0020 must.
    const impostor = !!(body.install_id && prev?.install_id && prev.install_id !== body.install_id);

    const rebound = !!(body.merchant_id && prev?.merchant_id && prev.merchant_id !== body.merchant_id);
    if (impostor) {
      await rows("vendorGateway", `
        INSERT INTO vendor_security_alerts (device_id, risk_type, severity, detail)
        SELECT $1, 'DEVICE_ID_CONFLICT', 'HIGH', $2
         WHERE NOT EXISTS (
           SELECT 1 FROM vendor_security_alerts
            WHERE device_id = $1 AND risk_type = 'DEVICE_ID_CONFLICT'
              AND created_at > now() - interval '1 hour')
      `, [
        body.device_id,
        `device id "${body.device_id}" is being used by two different phones (install ids differ). ` +
        `Whichever checks in last owns the banker binding, so the other phone's capture requests ` +
        `are not delivered. Give one of them a different device id in the agent.`,
      ]).catch(() => {});
    }
    if (rebound) {
      const flipBack = prev!.prev_merchant_id === body.merchant_id;
      const changedAt = prev!.merchant_changed_at ? Date.parse(prev!.merchant_changed_at) : NaN;
      const churned = Number.isFinite(changedAt) && Date.now() - changedAt < 24 * 60 * 60 * 1000;
      if (flipBack || churned) {
        // One alert per device per hour. The phones trade the binding on every heartbeat, so an
        // undeduped insert would bury every other security alert within a day.
        await rows("vendorGateway", `
          INSERT INTO vendor_security_alerts (device_id, risk_type, severity, detail)
          SELECT $1, 'DEVICE_ID_CONFLICT', $2, $3
           WHERE NOT EXISTS (
             SELECT 1 FROM vendor_security_alerts
              WHERE device_id = $1 AND risk_type = 'DEVICE_ID_CONFLICT'
                AND created_at > now() - interval '1 hour')
        `, [
          body.device_id, flipBack ? "HIGH" : "MEDIUM",
          `device id "${body.device_id}" is in use by more than one phone: banker binding moved ` +
          `${prev!.merchant_id} → ${body.merchant_id}` +
          (flipBack ? ` and back (previously ${prev!.prev_merchant_id})` : "") +
          `. While it points at ${body.merchant_id}, ${prev!.merchant_id}'s capture requests are ` +
          `not delivered. Give one phone a different device id in the agent.`,
        ]).catch(() => {});
      }
    }

    await rows("vendorGateway", `
      INSERT INTO vendor_devices (device_id, status, merchant_id, label, sim_id, app_hash, app_version, notif_access, agent_enabled, last_host, capture_apps, auto_capture, counters, parser_version, keep_awake, overlay_ok, charging, install_id, last_heartbeat, updated_at)
      VALUES ($1, 'UNKNOWN', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $15, $16, $17, $18, now(), now())
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
        counters = COALESCE($12::jsonb, vendor_devices.counters),
        parser_version = COALESCE($13, vendor_devices.parser_version),
        keep_awake = COALESCE($15, vendor_devices.keep_awake),
        overlay_ok = COALESCE($16, vendor_devices.overlay_ok),
        charging = COALESCE($17, vendor_devices.charging),
        install_id = COALESCE($18, vendor_devices.install_id),
        -- Remember where the binding came from, so a move BACK is recognisable as two phones
        -- rather than one phone being re-enrolled. Only written when the code actually changes;
        -- an ordinary heartbeat must not overwrite the history with the current value.
        prev_merchant_id = CASE WHEN $14::boolean THEN vendor_devices.merchant_id ELSE vendor_devices.prev_merchant_id END,
        merchant_changed_at = CASE WHEN $14::boolean THEN now() ELSE vendor_devices.merchant_changed_at END,
        last_heartbeat = now(), updated_at = now()
    `, [body.device_id, body.merchant_id ?? null, body.label ?? null, body.sim_id ?? null, body.app_hash ?? null,
        body.app_version ?? null, body.notif_access ?? null, body.agent_enabled ?? null, host,
        body.capture_apps ?? null, body.auto_capture ?? null,
        counters ? JSON.stringify(counters) : null, body.parser_version ?? null, rebound,
        body.keep_awake ?? null, body.overlay_ok ?? null, body.charging ?? null, body.install_id ?? null]);

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
