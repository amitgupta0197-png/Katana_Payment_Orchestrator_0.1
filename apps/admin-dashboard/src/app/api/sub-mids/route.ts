// Persona policy (PRODUCT_VISION §3.2):
//   SUPER_ADMIN — list all main + sub-MIDs; create both.
//   PROVIDER    — list sub-MIDs scoped by provider_id; request sub-MIDs for mapped merchants.
//   MERCHANT    — list own sub-MIDs; no mutations.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;

  try {
    const subParams: unknown[] = [];
    let subWhere = "TRUE";
    if (s.persona === "PROVIDER") {
      subWhere = `s.provider_id = $${subParams.length + 1}::uuid`;
      subParams.push(s.scope_id);
    } else if (s.persona === "MERCHANT") {
      subWhere = `s.merchant_id = $${subParams.length + 1}`;
      subParams.push(s.scope_id);
    }
    const subMids = await rows<any>("mid", `
      SELECT s.id, s.sub_mid_code, s.traffic_mode, s.kyc_status, s.settlement_enabled,
             s.status, s.tenant_id, s.merchant_id, s.requested_at, s.approved_at,
             COALESCE(s.approved_by,'') AS approved_by,
             m.mid_code AS main_mid_code,
             COALESCE(s.provider_id::text,'') AS provider_id
        FROM sub_mids s JOIN main_mids m ON m.id = s.main_mid_id
       WHERE ${subWhere}
       ORDER BY s.requested_at DESC LIMIT 200
    `, subParams);

    const mainParams: unknown[] = [];
    let mainWhere = "TRUE";
    if (s.persona === "MERCHANT") {
      mainWhere = `m.merchant_id = $${mainParams.length + 1}`;
      mainParams.push(s.scope_id);
    } else if (s.persona === "PROVIDER") {
      // Provider sees main MIDs of mapped merchants — derive from the sub-MID rows already filtered.
      const merchantIds = Array.from(new Set(subMids.map((r: any) => r.merchant_id))).filter(Boolean);
      if (!merchantIds.length) {
        return NextResponse.json({ main_mids: [], sub_mids: subMids });
      }
      mainWhere = `m.merchant_id = ANY($${mainParams.length + 1}::text[])`;
      mainParams.push(merchantIds);
    }
    const mains = await rows<any>("mid", `
      SELECT m.id, m.mid_code, m.tenant_id, m.merchant_id, m.status, m.settlement_enabled,
             m.created_at,
             (SELECT COUNT(*)::int FROM sub_mids s WHERE s.main_mid_id = m.id) AS sub_mid_count
        FROM main_mids m
       WHERE ${mainWhere}
       ORDER BY m.created_at DESC LIMIT 50
    `, mainParams);
    return NextResponse.json({ main_mids: mains, sub_mids: subMids });
  } catch (err) {
    const e = pgError(err);
    return NextResponse.json(e.body, { status: e.status });
  }
}

const createSchema = z.object({
  kind: z.literal("create_sub_mid"),
  main_mid_code: z.string().min(2),
  merchant_id: z.string().min(2),
  sub_mid_code: z.string().min(2),
  traffic_mode: z.enum(["KYC_APPROVED","TRAFFIC"]).default("TRAFFIC"),
  provider_id: z.string().uuid().optional(),
});

const createMainSchema = z.object({
  kind: z.literal("create_main_mid"),
  merchant_id: z.string().min(2),
  mid_code: z.string().min(2),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;

  const tenant = req.headers.get("x-tenant-id") ?? "tenant-default";
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  try {
    if (body.kind === "create_main_mid") {
      // Only SUPER_ADMIN creates main MIDs (§2.2 step 6).
      if (s.persona !== "SUPER_ADMIN")
        return NextResponse.json({ error: "main MID creation is super-admin only" }, { status: 403 });
      const v = createMainSchema.parse(body);
      const res = await rows<any>("mid", `
        INSERT INTO main_mids (tenant_id, merchant_id, mid_code, created_by)
        VALUES ($1, $2, $3, $4)
        RETURNING id, mid_code, merchant_id, status, settlement_enabled, created_at
      `, [tenant, v.merchant_id, v.mid_code, s.user_id]);
      return NextResponse.json(res[0]);
    }
    if (body.kind === "create_sub_mid") {
      const v = createSchema.parse(body);
      // Provider can only request for a merchant they're mapped to.
      if (s.persona === "PROVIDER") {
        const mapped = await rows<any>("provider", `
          SELECT 1 FROM provider_merchant_mappings
           WHERE provider_id = $1::uuid AND merchant_id::text = $2 AND status = 'ACTIVE'
        `, [s.scope_id, v.merchant_id]);
        if (!mapped.length)
          return NextResponse.json({ error: "merchant not mapped to your provider" }, { status: 403 });
      }
      const main = await rows<any>("mid", `SELECT id FROM main_mids WHERE tenant_id = $1 AND mid_code = $2`,
        [tenant, v.main_mid_code]);
      if (!main.length) return NextResponse.json({ error: "main MID not found" }, { status: 404 });
      const providerId = s.persona === "PROVIDER" ? s.scope_id : (v.provider_id ?? null);
      const res = await rows<any>("mid", `
        INSERT INTO sub_mids (main_mid_id, tenant_id, merchant_id, provider_id,
                              sub_mid_code, traffic_mode, kyc_status, settlement_enabled)
        VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::text, 'PENDING', FALSE)
        RETURNING id, sub_mid_code, traffic_mode, kyc_status, settlement_enabled, status, requested_at
      `, [main[0].id, tenant, v.merchant_id, providerId, v.sub_mid_code, v.traffic_mode]);
      await rows("mid", `
        INSERT INTO sub_mid_status_history (sub_mid_id, from_status, to_status, from_mode, to_mode, actor, notes)
        VALUES ($1::uuid, NULL, 'ACTIVE', NULL, $2, $3, 'sub-MID created')
      `, [res[0].id, v.traffic_mode, s.user_id]);
      return NextResponse.json(res[0]);
    }
    return NextResponse.json({ error: "unknown kind" }, { status: 400 });
  } catch (err) {
    const e = pgError(err);
    return NextResponse.json(e.body, { status: e.status });
  }
}
