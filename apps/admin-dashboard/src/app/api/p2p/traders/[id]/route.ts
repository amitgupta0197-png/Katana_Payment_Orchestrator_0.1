// P2P trader detail + management. SUPER_ADMIN.
//   GET   — trader + VPAs + sub-users + recent collections
//   PATCH — update fields/limits/status/vpa_mode/provider, or actions:
//             add_vpa {vpa,label}, remove_vpa {vpa}, set_active_vpa {vpa}

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const t = await rows<any>("p2p", `
      SELECT id::text, trader_code, name, kind, contact_email, contact_phone, status, risk_tier,
             per_txn_max, daily_amount_max, daily_count_max, vpa_mode,
             COALESCE(provider_id::text,'') AS provider_id, created_at
        FROM p2p_traders WHERE id = $1::uuid
    `, [id]);
    if (!t.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    const vpas = await rows<any>("p2p", `SELECT id::text, vpa, label, status, is_primary, created_at FROM p2p_trader_vpas WHERE trader_id = $1::uuid ORDER BY is_primary DESC, created_at ASC`, [id]);
    const users = await rows<any>("p2p", `SELECT id::text, email, role, created_at FROM p2p_trader_users WHERE trader_id = $1::uuid ORDER BY created_at ASC`, [id]);
    const collections = await rows<any>("p2p", `SELECT id::text, vpa, amount::float AS amount, utr, status, match_result, created_at FROM p2p_collections WHERE trader_id = $1::uuid ORDER BY created_at DESC LIMIT 50`, [id]);
    return NextResponse.json({ trader: t[0], vpas, users, collections });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const patchSchema = z.object({
  action: z.enum(["update", "add_vpa", "remove_vpa", "set_active_vpa"]).default("update"),
  // update fields
  status: z.enum(["ACTIVE", "SUSPENDED", "TERMINATED"]).optional(),
  risk_tier: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  per_txn_max: z.coerce.number().positive().optional(),
  daily_amount_max: z.coerce.number().positive().optional(),
  daily_count_max: z.coerce.number().int().positive().optional(),
  vpa_mode: z.enum(["STATIC", "DYNAMIC"]).optional(),
  provider_id: z.string().uuid().nullable().optional(),
  // vpa actions
  vpa: z.string().optional(),
  label: z.string().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body;
  try { body = patchSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    if (body.action === "add_vpa") {
      if (!body.vpa?.trim()) return NextResponse.json({ error: "vpa required" }, { status: 400 });
      await rows("p2p", `INSERT INTO p2p_trader_vpas (trader_id, vpa, label, status) VALUES ($1::uuid,$2,$3,'READY') ON CONFLICT (trader_id, vpa) DO NOTHING`, [id, body.vpa.trim(), body.label ?? null]);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "remove_vpa") {
      await rows("p2p", `DELETE FROM p2p_trader_vpas WHERE trader_id = $1::uuid AND vpa = $2`, [id, body.vpa]);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "set_active_vpa") {
      await rows("p2p", `UPDATE p2p_trader_vpas SET status='READY' WHERE trader_id=$1::uuid AND status='ACTIVE'`, [id]);
      await rows("p2p", `UPDATE p2p_trader_vpas SET status='ACTIVE' WHERE trader_id=$1::uuid AND vpa=$2`, [id, body.vpa]);
      return NextResponse.json({ ok: true });
    }
    // generic field update
    const sets: string[] = []; const args: unknown[] = [id]; let i = 2;
    for (const k of ["status", "risk_tier", "per_txn_max", "daily_amount_max", "daily_count_max", "vpa_mode"] as const) {
      if (body[k] !== undefined) { sets.push(`${k} = $${i++}`); args.push(body[k]); }
    }
    if (body.provider_id !== undefined) { sets.push(`provider_id = $${i++}::uuid`); args.push(body.provider_id); }
    if (!sets.length) return NextResponse.json({ error: "no fields to update" }, { status: 400 });
    const r = await rows<any>("p2p", `UPDATE p2p_traders SET ${sets.join(", ")}, updated_at = now() WHERE id = $1::uuid RETURNING id::text, status, risk_tier, per_txn_max, daily_amount_max, vpa_mode`, args);
    if (!r.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(r[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
