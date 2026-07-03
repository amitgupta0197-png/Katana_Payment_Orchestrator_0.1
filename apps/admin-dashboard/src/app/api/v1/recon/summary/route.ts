// GET /api/v1/recon/summary — Transaction Reconciliation & Forensic console feed:
// open manual cases (ops fallback), open security alerts (risk), enrolled devices,
// and the recent raw-alert stream, plus headline counts.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

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
    const devices = await rows<any>("vendorGateway", `
      SELECT device_id, COALESCE(label,'') AS label, COALESCE(merchant_id,'') AS merchant_id, status,
             COALESCE(sim_id,'') AS sim_id, last_heartbeat, created_at
        FROM vendor_devices ORDER BY (status='UNKNOWN') DESC, updated_at DESC LIMIT 200
    `).catch(() => []);
    const recent = await rows<any>("vendorGateway", `
      SELECT id::text, source, device_id, device_status, bank, COALESCE(sender,'') AS sender,
             amount::float AS amount, COALESCE(utr,'') AS utr, COALESCE(payer_name,'') AS payer_name,
             COALESCE(payer_vpa,'') AS payer_vpa, match_confidence, outcome, detail, created_at
        FROM vendor_txn_alerts ORDER BY created_at DESC LIMIT 100
    `).catch(() => []);

    const c1 = (await rows<{ n: string }>("vendorGateway", `SELECT COUNT(*)::text n FROM vendor_manual_cases WHERE status='OPEN'`).catch(() => [{ n: "0" }]))[0];
    const c2 = (await rows<{ n: string }>("vendorGateway", `SELECT COUNT(*)::text n FROM vendor_security_alerts WHERE status='OPEN'`).catch(() => [{ n: "0" }]))[0];
    const c3 = (await rows<{ n: string }>("vendorGateway", `SELECT COUNT(*)::text n FROM vendor_devices WHERE status='TRUSTED'`).catch(() => [{ n: "0" }]))[0];
    const c4 = (await rows<{ n: string }>("vendorGateway", `SELECT COUNT(*)::text n FROM vendor_txn_alerts WHERE outcome='CONFIRMED' AND created_at >= now() - interval '24 hours'`).catch(() => [{ n: "0" }]))[0];

    return NextResponse.json({
      counts: {
        cases_open: Number(c1?.n ?? 0),
        alerts_open: Number(c2?.n ?? 0),
        devices_trusted: Number(c3?.n ?? 0),
        confirmed_24h: Number(c4?.n ?? 0),
      },
      cases, security, devices, recent,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
