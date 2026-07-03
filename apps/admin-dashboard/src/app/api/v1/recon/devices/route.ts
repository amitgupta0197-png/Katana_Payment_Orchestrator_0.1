// /api/v1/recon/devices — forwarder device registry (architecture §4 Device, §5
// Super Admin). POST registers a device or sets its trust status (TRUSTED enables
// auto-confirm; SUSPENDED/REVOKED forces manual review). GET lists devices.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";
const ROLES = ["SUPER_ADMIN", "ADMIN", "RISK"] as const;

export async function GET() {
  const g = await gateOrResponse([...ROLES]);
  if ("response" in g) return g.response;
  try {
    const devices = await rows<any>("vendorGateway", `
      SELECT device_id, COALESCE(label,'') AS label, COALESCE(merchant_id,'') AS merchant_id, status,
             COALESCE(sim_id,'') AS sim_id, last_heartbeat, created_at
        FROM vendor_devices ORDER BY updated_at DESC LIMIT 500
    `).catch(() => []);
    return NextResponse.json({ devices });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  device_id: z.string().min(1).max(120),
  status: z.enum(["TRUSTED", "UNKNOWN", "SUSPENDED", "REVOKED"]).optional(),
  label: z.string().max(120).optional(),
  merchant_id: z.string().max(120).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse([...ROLES]);
  if ("response" in g) return g.response;
  let body; try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  try {
    await rows("vendorGateway", `
      INSERT INTO vendor_devices (device_id, status, label, merchant_id, registered_by, updated_at)
      VALUES ($1, COALESCE($2,'UNKNOWN'), $3, $4, $5, now())
      ON CONFLICT (device_id) DO UPDATE SET
        status = COALESCE($2, vendor_devices.status),
        label = COALESCE($3, vendor_devices.label),
        merchant_id = COALESCE($4, vendor_devices.merchant_id),
        updated_at = now()
    `, [body.device_id, body.status ?? null, body.label ?? null, body.merchant_id ?? null, g.session.email]);
    await rows("vendorGateway", `
      INSERT INTO vendor_recon_audit (actor, action, entity, entity_id, detail)
      VALUES ($1,$2,'device',$3,$4)
    `, [g.session.email, `DEVICE_${body.status ?? "UPSERT"}`, body.device_id, body.label ?? ""]).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
