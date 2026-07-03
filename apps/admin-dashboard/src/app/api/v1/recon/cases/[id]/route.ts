// POST /api/v1/recon/cases/:id — operations resolves a manual verification case
// (architecture §6 fallback). CONFIRM confirms the linked order (manual evidence);
// REJECT closes the case without confirming. Both write an audit row.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { confirmPoolPayOrder } from "@/lib/poolpay-order";

export const dynamic = "force-dynamic";
const ROLES = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE"] as const;

const schema = z.object({
  action: z.enum(["CONFIRM", "REJECT"]),
  utr: z.string().max(40).optional(),
  note: z.string().max(500).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse([...ROLES]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body; try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  try {
    const cur = (await rows<any>("vendorGateway",
      `SELECT case_id::text, order_id::text, order_ref, status, expected_amount::float AS expected_amount FROM vendor_manual_cases WHERE case_id = $1::uuid`, [id]))[0];
    if (!cur) return NextResponse.json({ error: "case not found" }, { status: 404 });
    if (cur.status !== "OPEN") return NextResponse.json({ error: `case already ${cur.status}` }, { status: 409 });

    let confirmResult: any = null;
    if (body.action === "CONFIRM") {
      if (!cur.order_id) return NextResponse.json({ error: "case has no linked order to confirm" }, { status: 400 });
      confirmResult = await confirmPoolPayOrder({
        id: cur.order_id, outcome: "SUCCESS", utr: body.utr ?? null,
        evidence: "MANUAL", actor: g.session.email, note: body.note ?? "manual case resolved",
      });
      if (!confirmResult.ok) return NextResponse.json({ error: confirmResult.error }, { status: confirmResult.status });
    }

    const newStatus = body.action === "CONFIRM" ? "RESOLVED" : "REJECTED";
    await rows("vendorGateway", `
      UPDATE vendor_manual_cases
         SET status = $2, resolution = $3, resolved_by = $4, resolved_at = now()
       WHERE case_id = $1::uuid
    `, [id, newStatus, body.note ?? body.action, g.session.email]);
    await rows("vendorGateway", `
      INSERT INTO vendor_recon_audit (actor, action, entity, entity_id, detail)
      VALUES ($1,$2,'manual_case',$3,$4)
    `, [g.session.email, `CASE_${body.action}`, id, `${cur.order_ref ?? "-"} ${body.note ?? ""}`]).catch(() => {});

    return NextResponse.json({ ok: true, status: newStatus, confirm: confirmResult });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
