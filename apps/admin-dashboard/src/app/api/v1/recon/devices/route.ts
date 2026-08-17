// /api/v1/recon/devices — forwarder device registry (architecture §4 Device, §5
// Super Admin). POST registers a device or sets its trust status (TRUSTED enables
// auto-confirm; SUSPENDED/REVOKED forces manual review). GET lists devices.
//
// A device also carries WHICH UPI ID IT RECEIVES ON. A banker can collect on several
// (PRVZS23 has four) and several phones capture for one banker code, while the payment itself
// never names the destination — GPay for Business reports payer, method, amounts and its two
// transaction ids, and nothing about where the money landed. One phone holds one GPay login,
// so recording it per device is what makes the destination knowable at all; every credit that
// device captures then inherits it, marked as device-derived rather than payment-stated.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { settlementVpasFor } from "@/lib/settlement-vpa";

export const dynamic = "force-dynamic";
const ROLES = ["SUPER_ADMIN", "ADMIN", "RISK"] as const;

export async function GET() {
  const g = await gateOrResponse([...ROLES]);
  if ("response" in g) return g.response;
  try {
    const devices = await rows<any>("vendorGateway", `
      SELECT device_id, COALESCE(label,'') AS label, COALESCE(merchant_id,'') AS merchant_id, status,
             COALESCE(sim_id,'') AS sim_id, COALESCE(last_host,'') AS last_host,
             COALESCE(receiving_vpa,'') AS receiving_vpa, last_heartbeat, created_at
        FROM vendor_devices ORDER BY updated_at DESC LIMIT 500
    `).catch(() => rows<any>("vendorGateway", `
      SELECT device_id, COALESCE(label,'') AS label, COALESCE(merchant_id,'') AS merchant_id, status,
             COALESCE(sim_id,'') AS sim_id, COALESCE(last_host,'') AS last_host, last_heartbeat, created_at
        FROM vendor_devices ORDER BY updated_at DESC LIMIT 500
    `).catch(() => []));

    // The VPAs each banker is configured to receive on — the only values a device may be
    // mapped to, so the screen offers a choice rather than a free-text field to mistype.
    const codes = [...new Set(devices.map((d) => d.merchant_id).filter(Boolean))] as string[];
    const vpaOptions: Record<string, string[]> = {};
    for (const code of codes) vpaOptions[code] = await settlementVpasFor([code]).catch(() => []);

    return NextResponse.json({ devices, vpa_options: vpaOptions });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  device_id: z.string().min(1).max(120),
  status: z.enum(["TRUSTED", "UNKNOWN", "SUSPENDED", "REVOKED"]).optional(),
  label: z.string().max(120).optional(),
  merchant_id: z.string().max(120).optional(),
  /** UPI ID this phone receives on. "" clears it. Must be one of the banker's configured VPAs. */
  receiving_vpa: z.string().max(120).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse([...ROLES]);
  if ("response" in g) return g.response;
  let body; try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  try {
    // Validate a receiving VPA against the banker that owns the device. A typo or another
    // banker's UPI ID here would attach every future credit from this phone to the wrong
    // account — and would then read as verified fact on three dashboards.
    let receivingVpa: string | null | undefined = undefined;
    // The banker the mapping belongs to. A phone's banker code is typed into the agent and can
    // be changed — "Author new" captured for PRIMESX and later PRVZS23 — so the backfill below
    // must not reach past the banker this VPA was validated against.
    let owner: string | null = null;
    if (body.receiving_vpa !== undefined) {
      const wanted = body.receiving_vpa.trim().toLowerCase();
      if (!wanted) receivingVpa = null;                        // explicit clear
      else {
        owner = body.merchant_id ?? (await rows<{ m: string | null }>("vendorGateway",
          `SELECT merchant_id AS m FROM vendor_devices WHERE device_id = $1`, [body.device_id]).catch(() => []))[0]?.m ?? null;
        if (!owner)
          return NextResponse.json({ error: "assign this device to a banker before setting the UPI ID it receives on" }, { status: 400 });
        const allowed = (await settlementVpasFor([owner]).catch(() => [])).map((v) => v.trim().toLowerCase());
        if (!allowed.includes(wanted))
          return NextResponse.json({
            error: `${wanted} is not a settlement VPA configured for ${owner}`,
            allowed,
          }, { status: 400 });
        receivingVpa = wanted;
      }
    }

    await rows("vendorGateway", `
      INSERT INTO vendor_devices (device_id, status, label, merchant_id, receiving_vpa, registered_by, updated_at)
      VALUES ($1, COALESCE($2,'UNKNOWN'), $3, $4, $6, $5, now())
      ON CONFLICT (device_id) DO UPDATE SET
        status = COALESCE($2, vendor_devices.status),
        label = COALESCE($3, vendor_devices.label),
        merchant_id = COALESCE($4, vendor_devices.merchant_id),
        -- $7 says whether the caller addressed this field at all, so an unrelated POST
        -- (a trust change) cannot blank a mapping, while an explicit "" can.
        receiving_vpa = CASE WHEN $7 THEN $6 ELSE vendor_devices.receiving_vpa END,
        updated_at = now()
    `, [body.device_id, body.status ?? null, body.label ?? null, body.merchant_id ?? null, g.session.email,
        receivingVpa ?? null, receivingVpa !== undefined]);

    // Apply it to what this device ALREADY captured. Those credits landed on the same UPI ID —
    // the phone's GPay login has not changed — so leaving them blank would make the mapping look
    // like it only half worked. Only rows with no destination are touched: a VPA the payment
    // itself stated is stronger evidence and is never overwritten.
    let backfilled = 0;
    if (receivingVpa) {
      const r = await rows<{ n: string }>("vendorGateway", `
        WITH upd AS (
          UPDATE vendor_txn_alerts
             SET payee_vpa = $2, payee_vpa_source = 'DEVICE'
           WHERE device_id = $1 AND payee_vpa IS NULL
             AND COALESCE(direction,'CREDIT') = 'CREDIT'
             -- A settlement leg is a deposit into the bank account, not a credit to a UPI ID.
             AND COALESCE(txn_type,'CREDIT') <> 'SETTLEMENT'
             -- Only this banker's traffic from this phone. The same device captured for two
             -- banker codes in prod, and this VPA belongs to just one of them; untagged rows
             -- take it because the device is then the only record of where the money went.
             AND (merchant_id = $3 OR merchant_id IS NULL)
           RETURNING 1
        ) SELECT COUNT(*)::text AS n FROM upd
      `, [body.device_id, receivingVpa, owner]).catch(() => []);
      backfilled = Number(r[0]?.n ?? 0);
    }

    const detail = [
      body.label ?? "",
      receivingVpa === null ? "receiving VPA cleared"
        : receivingVpa ? `receives on ${receivingVpa}${backfilled ? ` · ${backfilled} past credits attributed` : ""}` : "",
    ].filter(Boolean).join(" · ");
    await rows("vendorGateway", `
      INSERT INTO vendor_recon_audit (actor, action, entity, entity_id, detail)
      VALUES ($1,$2,'device',$3,$4)
    `, [g.session.email, `DEVICE_${body.status ?? (receivingVpa !== undefined ? "VPA_SET" : "UPSERT")}`, body.device_id, detail]).catch(() => {});
    return NextResponse.json({ ok: true, receiving_vpa: receivingVpa, backfilled });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
