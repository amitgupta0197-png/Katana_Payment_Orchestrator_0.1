// Persona policy (PRODUCT_VISION §3.3):
//   SUPER_ADMIN — list all + funnel; create.
//   PROVIDER    — list mapped merchants (via provider_merchant_mappings); create (lead).
//   MERCHANT    — read own only (single row).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;

  try {
    const params: unknown[] = ["tenant-default"];
    let where = "tenant_id = $1";

    // Cross-service merchant identity is merchant_code (varchar), not the uuid PK.
    if (s.persona === "MERCHANT") {
      where += " AND merchant_code = $2";
      params.push(s.scope_id);
    } else if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ merchants: [], funnel: [] });
      where += ` AND merchant_code = ANY($${params.length + 1}::text[])`;
      params.push(ids);
    }

    const merchants = await rows<any>("merchant", `
      SELECT id, merchant_code, legal_name, brand_name, business_type, category_mcc,
             contact_email, stage, risk_tier,
             step_application, step_kyb_docs, step_screening, step_bank_verify, step_config, step_approval,
             created_at, approved_at, COALESCE(approved_by,'') AS approved_by
        FROM merchants
       WHERE ${where}
       ORDER BY created_at DESC LIMIT 200
    `, params);

    // Funnel is meaningful only for SUPER_ADMIN; scoped personas see their own row(s).
    const funnel = s.persona === "SUPER_ADMIN"
      ? await rows<any>("merchant", `SELECT stage, COUNT(*)::int AS n FROM merchants GROUP BY stage`)
      : [];
    return NextResponse.json({ merchants, funnel });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  merchant_code: z.string().min(2),
  legal_name: z.string().min(2),
  brand_name: z.string().optional(),
  business_type: z.string().optional(),
  category_mcc: z.string().optional(),
  contact_email: z.string().email(),
  contact_phone: z.string().optional(),
  website: z.string().url().optional(),
  registered_address: z.string().optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;

  let body;
  try { body = createSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const res = await rows<any>("merchant", `
      INSERT INTO merchants (tenant_id, merchant_code, legal_name, brand_name, business_type,
                             category_mcc, contact_email, contact_phone, website, registered_address,
                             stage, step_application)
      VALUES ('tenant-default', $1, $2, $3, $4, $5, $6, $7, $8, $9, 'APPLICATION', true)
      RETURNING id, merchant_code, stage
    `, [body.merchant_code, body.legal_name, body.brand_name ?? null, body.business_type ?? null,
        body.category_mcc ?? null, body.contact_email, body.contact_phone ?? null,
        body.website ?? null, body.registered_address ?? null]);
    await rows("merchant", `
      INSERT INTO merchant_activity (merchant_id, action, actor, payload)
      VALUES ($1::uuid, 'APPLICATION_SUBMITTED', $2, $3::jsonb)
    `, [res[0].id, s.email, JSON.stringify(body)]);

    // Provider that creates a lead is auto-mapped to it.
    // mappings.merchant_id is varchar (merchant_code), relation defaults to PRIMARY.
    if (s.persona === "PROVIDER" && s.scope_id) {
      await rows("provider", `
        INSERT INTO provider_merchant_mappings (provider_id, merchant_id, relation)
        VALUES ($1::uuid, $2, 'PRIMARY')
        ON CONFLICT (provider_id, merchant_id) DO NOTHING
      `, [s.scope_id, res[0].merchant_code]).catch(() => {});
    }
    return NextResponse.json(res[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
