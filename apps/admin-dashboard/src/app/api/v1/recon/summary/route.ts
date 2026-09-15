// GET /api/v1/recon/summary — Transaction Reconciliation & Forensic console feed:
// open manual cases (ops fallback), open security alerts (risk), enrolled devices,
// and the recent raw-alert stream, plus headline counts.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { settlementVpasFor } from "@/lib/settlement-vpa";

export const dynamic = "force-dynamic";
const ROLES = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE", "RISK", "COMPLIANCE"] as const;

export async function GET() {
  const g = await gateOrResponse([...ROLES]);
  if ("response" in g) return g.response;
  try {
    const cases = await rows<any>("vendorGateway", `
      SELECT c.case_id::text, c.order_ref, c.device_id, c.reason, c.expected_amount::float AS expected_amount,
             c.confidence, c.detail, c.status, c.created_at, d.last_heartbeat, d.status AS device_status
        FROM vendor_manual_cases c
        LEFT JOIN vendor_devices d ON d.device_id = c.device_id
       WHERE c.status = 'OPEN' ORDER BY c.created_at DESC LIMIT 200
    `).catch(() => []);
    const security = await rows<any>("vendorGateway", `
      SELECT alert_id::text, device_id, risk_type, severity, detail, status, created_at
        FROM vendor_security_alerts WHERE status = 'OPEN'
       ORDER BY (severity='CRITICAL') DESC, (severity='HIGH') DESC, created_at DESC LIMIT 200
    `).catch(() => []);
    // DEVICES, INCLUDING ONES THAT ONLY EXIST IN THE ALERT HISTORY.
    //
    // `receiving_vpa` (migration 0019) is which UPI ID this phone collects on — the payment
    // never says, so this mapping is the only thing that can answer it.
    //
    // The registry alone is not enough to offer that mapping. Credits in prod arrived from
    // "S23", "Arthur 🔱" and "Arthur 🎨", none of which is enrolled any more (device_id is the
    // name the merchant types into the agent, so renaming a phone or a registry cleanup leaves
    // its captures behind). Listing only enrolled devices would make those credits permanently
    // unattributable. So anything seen on a credit is listed too, flagged `unenrolled`, with the
    // banker code taken from its most recent alert — mapping it upserts a real row.
    //
    // Retried without receiving_vpa so a database that has not had 0019 applied still lists
    // its devices rather than showing none.
    const deviceSql = (withVpa: boolean) => `
      WITH seen AS (
        SELECT device_id,
               MAX(created_at) AS last_alert,
               (ARRAY_AGG(merchant_id ORDER BY created_at DESC))[1] AS merchant_id
          FROM vendor_txn_alerts WHERE device_id IS NOT NULL AND device_id <> ''
         GROUP BY device_id
      )
      SELECT d.device_id, COALESCE(d.label,'') AS label,
             COALESCE(NULLIF(d.merchant_id,''), s.merchant_id, '') AS merchant_id,
             d.status, COALESCE(d.sim_id,'') AS sim_id,
             ${withVpa ? "COALESCE(d.receiving_vpa,'')" : "''"} AS receiving_vpa,
             d.last_heartbeat, d.created_at, false AS unenrolled,
             COALESCE(d.updated_at, s.last_alert, d.created_at) AS seen_at
        FROM vendor_devices d LEFT JOIN seen s ON s.device_id = d.device_id
      UNION ALL
      SELECT s.device_id, '' AS label, COALESCE(s.merchant_id,'') AS merchant_id,
             'UNKNOWN' AS status, '' AS sim_id, '' AS receiving_vpa,
             NULL::timestamptz AS last_heartbeat, s.last_alert AS created_at, true AS unenrolled,
             s.last_alert AS seen_at
        FROM seen s
       WHERE NOT EXISTS (SELECT 1 FROM vendor_devices d WHERE d.device_id = s.device_id)
       ORDER BY (status = 'UNKNOWN') DESC, seen_at DESC
       LIMIT 200`;
    const devices = await rows<any>("vendorGateway", deviceSql(true))
      .catch(() => rows<any>("vendorGateway", deviceSql(false)).catch(() => []));

    // The VPAs each banker receives on, so the device screen offers a choice of real values
    // instead of a free-text field that could silently attach a phone to the wrong account.
    const deviceCodes = [...new Set(devices.map((x: any) => x.merchant_id).filter(Boolean))] as string[];
    const vpa_options: Record<string, string[]> = {};
    for (const code of deviceCodes) vpa_options[code] = await settlementVpasFor([code]).catch(() => []);
    const recent = await rows<any>("vendorGateway", `
      SELECT id::text, source, device_id, device_status, bank, COALESCE(sender,'') AS sender,
             amount::float AS amount, COALESCE(utr,'') AS utr, COALESCE(payer_name,'') AS payer_name,
             COALESCE(payer_vpa,'') AS payer_vpa, match_confidence, outcome, detail, created_at
        FROM vendor_txn_alerts ORDER BY created_at DESC LIMIT 100
    `).catch(() => []);

    const c1 = (await rows<{ n: string }>("vendorGateway", `SELECT COUNT(*)::text n FROM vendor_manual_cases WHERE status='OPEN'`).catch(() => [{ n: "0" }]))[0];
    const c2 = (await rows<{ n: string }>("vendorGateway", `SELECT COUNT(*)::text n FROM vendor_security_alerts WHERE status='OPEN'`).catch(() => [{ n: "0" }]))[0];
    const c3 = (await rows<{ n: string }>("vendorGateway", `SELECT COUNT(*)::text n FROM vendor_devices WHERE status='TRUSTED'`).catch(() => [{ n: "0" }]))[0];
    const c4 = (await rows<{ n: string }>("vendorGateway", `SELECT COUNT(*)::text n FROM vendor_txn_alerts WHERE outcome='CONFIRMED' AND livemode = true AND created_at >= now() - interval '24 hours'`).catch(() => [{ n: "0" }]))[0];

    return NextResponse.json({
      counts: {
        cases_open: Number(c1?.n ?? 0),
        alerts_open: Number(c2?.n ?? 0),
        devices_trusted: Number(c3?.n ?? 0),
        confirmed_24h: Number(c4?.n ?? 0),
      },
      cases, security, devices, recent, vpa_options,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
