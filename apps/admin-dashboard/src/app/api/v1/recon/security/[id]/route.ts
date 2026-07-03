// POST /api/v1/recon/security/:id — risk/security team reviews a forensic alert
// (architecture §5 Risk team, §7). REVIEW acknowledges; DISMISS closes as benign.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";
const ROLES = ["SUPER_ADMIN", "ADMIN", "RISK", "COMPLIANCE"] as const;

const schema = z.object({
  action: z.enum(["REVIEW", "DISMISS"]),
  note: z.string().max(500).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse([...ROLES]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body; try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  try {
    const newStatus = body.action === "REVIEW" ? "REVIEWED" : "DISMISSED";
    const upd = await rows<any>("vendorGateway", `
      UPDATE vendor_security_alerts
         SET status = $2, reviewed_by = $3, reviewed_at = now()
       WHERE alert_id = $1::uuid AND status = 'OPEN'
       RETURNING alert_id::text, risk_type
    `, [id, newStatus, g.session.email]);
    if (!upd.length) return NextResponse.json({ error: "alert not found or already closed" }, { status: 404 });
    await rows("vendorGateway", `
      INSERT INTO vendor_recon_audit (actor, action, entity, entity_id, detail)
      VALUES ($1,$2,'security_alert',$3,$4)
    `, [g.session.email, `SECURITY_${body.action}`, id, `${upd[0].risk_type} ${body.note ?? ""}`]).catch(() => {});
    return NextResponse.json({ ok: true, status: newStatus });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
