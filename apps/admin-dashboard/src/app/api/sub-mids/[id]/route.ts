// GET / PATCH a single sub-MID. SUPER_ADMIN approves / enables settlement.
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  try {
    const sub = await rows<any>("mid", `
      SELECT s.id::text, s.sub_mid_code, s.traffic_mode, s.kyc_status, s.settlement_enabled,
             s.status, s.tenant_id, s.merchant_id, s.requested_at, s.approved_at,
             COALESCE(s.approved_by,'') AS approved_by, m.mid_code AS main_mid_code,
             COALESCE(s.provider_id::text,'') AS provider_id,
             COALESCE(s.active_payin,false) AS active_payin
        FROM sub_mids s JOIN main_mids m ON m.id = s.main_mid_id
       WHERE s.id = $1::uuid
    `, [id]);
    if (!sub.length) return NextResponse.json({ error: "not found" }, { status: 404 });

    // Scope check.
    if (s.persona === "PROVIDER" && sub[0].provider_id !== s.scope_id)
      return NextResponse.json({ error: "sub-MID not owned by your provider" }, { status: 403 });
    if (s.persona === "MERCHANT" && sub[0].merchant_id !== s.scope_id)
      return NextResponse.json({ error: "sub-MID not owned by your merchant" }, { status: 403 });

    const limits = await rows<any>("mid", `
      SELECT id::text, per_txn_max, daily_amount, daily_count, monthly_amount, created_at
        FROM sub_mid_limits WHERE sub_mid_id = $1::uuid ORDER BY created_at DESC LIMIT 1
    `, [id]).catch(() => []);
    const history = await rows<any>("mid", `
      SELECT id::text, from_status, to_status, from_mode, to_mode, actor, notes, created_at
        FROM sub_mid_status_history WHERE sub_mid_id = $1::uuid ORDER BY created_at DESC LIMIT 50
    `, [id]).catch(() => []);

    return NextResponse.json({ sub_mid: sub[0], limits: limits[0] ?? null, history });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const patchSchema = z.object({
  action: z.enum([
    "approve_kyc", "enable_settlement", "approve_and_enable", "suspend", "terminate",
    "assign_provider", "set_active_payin", "clear_active_payin",
  ]).optional(),
  provider_id: z.string().uuid().nullable().optional(),
  notes: z.string().optional().default(""),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  let body;
  try { body = patchSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    const cur = await rows<any>("mid", `SELECT kyc_status, settlement_enabled, status, traffic_mode, merchant_id, COALESCE(provider_id::text,'') AS provider_id, active_payin FROM sub_mids WHERE id = $1::uuid`, [id]);
    if (!cur.length) return NextResponse.json({ error: "not found" }, { status: 404 });

    // One-click: map this sub-MID to a provider (or clear with provider_id=null).
    if (body.action === "assign_provider") {
      const r = await rows<any>("mid",
        `UPDATE sub_mids SET provider_id = $2::uuid WHERE id = $1::uuid RETURNING id::text, COALESCE(provider_id::text,'') AS provider_id`,
        [id, body.provider_id ?? null]);
      return NextResponse.json(r[0]);
    }

    // Make this the active pay-in target for its merchant (new payins route here).
    // The partial unique index allows only one active per merchant, so clear first.
    if (body.action === "set_active_payin") {
      await rows("mid", `UPDATE sub_mids SET active_payin = false WHERE merchant_id = $1 AND active_payin`, [cur[0].merchant_id]);
      const r = await rows<any>("mid",
        `UPDATE sub_mids SET active_payin = true WHERE id = $1::uuid RETURNING id::text, sub_mid_code, active_payin`, [id]);
      return NextResponse.json(r[0]);
    }
    if (body.action === "clear_active_payin") {
      const r = await rows<any>("mid",
        `UPDATE sub_mids SET active_payin = false WHERE id = $1::uuid RETURNING id::text, sub_mid_code, active_payin`, [id]);
      return NextResponse.json(r[0]);
    }

    let sql = "";
    const args: unknown[] = [id];
    if (body.action === "approve_kyc") {
      sql = `UPDATE sub_mids SET kyc_status='APPROVED', traffic_mode='KYC_APPROVED', approved_at=now(), approved_by=$2 WHERE id=$1::uuid RETURNING id::text, kyc_status, settlement_enabled, traffic_mode, status`;
      args.push(s.email);
    } else if (body.action === "enable_settlement") {
      if (cur[0].kyc_status !== "APPROVED")
        return NextResponse.json({ error: "kyc_status must be APPROVED first" }, { status: 409 });
      sql = `UPDATE sub_mids SET settlement_enabled=true, approved_at=COALESCE(approved_at,now()), approved_by=COALESCE(approved_by,$2) WHERE id=$1::uuid RETURNING id::text, kyc_status, settlement_enabled, traffic_mode, status`;
      args.push(s.email);
    } else if (body.action === "approve_and_enable") {
      sql = `UPDATE sub_mids SET kyc_status='APPROVED', traffic_mode='KYC_APPROVED', settlement_enabled=true, approved_at=now(), approved_by=$2 WHERE id=$1::uuid RETURNING id::text, kyc_status, settlement_enabled, traffic_mode, status`;
      args.push(s.email);
    } else if (body.action === "suspend") {
      sql = `UPDATE sub_mids SET status='SUSPENDED', settlement_enabled=false WHERE id=$1::uuid RETURNING id::text, kyc_status, settlement_enabled, traffic_mode, status`;
    } else if (body.action === "terminate") {
      sql = `UPDATE sub_mids SET status='TERMINATED', settlement_enabled=false WHERE id=$1::uuid RETURNING id::text, kyc_status, settlement_enabled, traffic_mode, status`;
    } else {
      return NextResponse.json({ error: "action required" }, { status: 400 });
    }

    const res = await rows<any>("mid", sql, args);
    await rows("mid", `
      INSERT INTO sub_mid_status_history (sub_mid_id, from_status, to_status, from_mode, to_mode, actor, notes)
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
    `, [id, cur[0].status, res[0].status, cur[0].traffic_mode, res[0].traffic_mode, s.email,
        `${body.action}: ${body.notes}`]).catch(() => {});
    return NextResponse.json(res[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
