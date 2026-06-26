// P2P traders — Individual + Business. SUPER_ADMIN manages; list includes VPA
// counts and today's collection totals.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const traders = await rows<any>("p2p", `
      SELECT t.id::text, t.trader_code, t.name, t.kind, t.status, t.risk_tier,
             t.per_txn_max, t.daily_amount_max, t.daily_count_max, t.vpa_mode,
             COALESCE(t.provider_id::text,'') AS provider_id, t.created_at,
             (SELECT COUNT(*)::int FROM p2p_trader_vpas v WHERE v.trader_id = t.id) AS vpa_count,
             (SELECT COALESCE(SUM(c.amount)::float,0) FROM p2p_collections c
                WHERE c.trader_id = t.id AND c.status = 'SUCCESS' AND c.created_at >= CURRENT_DATE) AS today_gross,
             (SELECT COUNT(*)::int FROM p2p_collections c
                WHERE c.trader_id = t.id AND c.created_at >= CURRENT_DATE) AS today_count
        FROM p2p_traders t WHERE t.tenant_id = 'tenant-default'
       ORDER BY t.created_at DESC LIMIT 500
    `).catch(() => []);
    return NextResponse.json({ traders });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  trader_code: z.string().min(2).max(60),
  name: z.string().min(2).max(255),
  kind: z.enum(["INDIVIDUAL", "BUSINESS"]).default("INDIVIDUAL"),
  contact_email: z.string().email().optional(),
  contact_phone: z.string().optional(),
  per_txn_max: z.coerce.number().positive().optional(),
  daily_amount_max: z.coerce.number().positive().optional(),
  daily_count_max: z.coerce.number().int().positive().optional(),
  vpa_mode: z.enum(["STATIC", "DYNAMIC"]).default("STATIC"),
  primary_vpa: z.string().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  let body;
  try { body = createSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const res = await rows<any>("p2p", `
      INSERT INTO p2p_traders (trader_code, name, kind, contact_email, contact_phone,
                               per_txn_max, daily_amount_max, daily_count_max, vpa_mode)
      VALUES ($1,$2,$3,$4,$5, COALESCE($6,100000), COALESCE($7,1000000), COALESCE($8,500), $9)
      ON CONFLICT (tenant_id, trader_code) DO NOTHING
      RETURNING id::text, trader_code, name, kind, status, vpa_mode
    `, [body.trader_code, body.name, body.kind, body.contact_email ?? null, body.contact_phone ?? null,
        body.per_txn_max ?? null, body.daily_amount_max ?? null, body.daily_count_max ?? null, body.vpa_mode]);
    if (!res.length) return NextResponse.json({ error: "trader_code already used" }, { status: 409 });

    if (body.primary_vpa?.trim()) {
      await rows("p2p", `
        INSERT INTO p2p_trader_vpas (trader_id, vpa, status, is_primary)
        VALUES ($1::uuid, $2, 'ACTIVE', true) ON CONFLICT (trader_id, vpa) DO NOTHING
      `, [res[0].id, body.primary_vpa.trim()]).catch(() => {});
    }
    return NextResponse.json(res[0], { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
