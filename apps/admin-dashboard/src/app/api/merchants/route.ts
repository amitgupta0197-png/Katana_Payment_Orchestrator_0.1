// Persona policy (PRODUCT_VISION §3.3):
//   SUPER_ADMIN — list all + funnel; create.
//   PROVIDER    — list mapped merchants (via provider_merchant_mappings); create (lead).
//   MERCHANT    — read own only (single row).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { hashPassword, generatePassword } from "@/lib/password";

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
  website: z.string().url().optional().or(z.literal("")),
  registered_address: z.string().optional(),
  // Optional: map this merchant under a provider at onboarding time.
  // PROVIDER persona ignores this (auto-mapped to itself below); SUPER_ADMIN may pick any provider.
  provider_id: z.string().uuid().optional(),
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
    // A new merchant starts at stage APPLICATION with NO steps completed. The
    // step_* flags mark a *transition* as done, so step_application must stay false
    // until the APPLICATION→DOCS_PENDING advance — otherwise the frontend (which
    // derives the next step from the flags) and the backend stage-gate desync and
    // the first advance fails with "cannot advance ... from stage APPLICATION".
    const res = await rows<any>("merchant", `
      INSERT INTO merchants (tenant_id, merchant_code, legal_name, brand_name, business_type,
                             category_mcc, contact_email, contact_phone, website, registered_address,
                             stage)
      VALUES ('tenant-default', $1, $2, $3, $4, $5, $6, $7, $8, $9, 'APPLICATION')
      RETURNING id, merchant_code, stage
    `, [body.merchant_code, body.legal_name, body.brand_name ?? null, body.business_type ?? null,
        body.category_mcc ?? null, body.contact_email, body.contact_phone ?? null,
        body.website ?? null, body.registered_address ?? null]);
    await rows("merchant", `
      INSERT INTO merchant_activity (merchant_id, action, actor, payload)
      VALUES ($1::uuid, 'APPLICATION_SUBMITTED', $2, $3::jsonb)
    `, [res[0].id, s.email, JSON.stringify(body)]);

    // Map the new merchant under a provider for traceability.
    // provider_merchant_mappings.merchant_id is the merchant UUID (not merchant_code);
    // status defaults to ACTIVE; mapped_by records who onboarded the merchant.
    //  - PROVIDER persona is auto-mapped to itself (it can only ever onboard under itself).
    //  - SUPER_ADMIN may pick any provider via body.provider_id.
    const mapProviderId = s.persona === "PROVIDER" ? s.scope_id : body.provider_id;
    if (mapProviderId) {
      await rows("provider", `
        INSERT INTO provider_merchant_mappings (provider_id, merchant_id, mapped_by)
        VALUES ($1::uuid, $2::uuid, $3)
        ON CONFLICT (provider_id, merchant_id) DO NOTHING
      `, [mapProviderId, res[0].id, s.email]).catch(() => {});
    }
    // Provision a MERCHANT login so the new merchant can sign in immediately.
    // Creating a merchant record alone never made an account, so this closes that
    // gap. A brand-new email gets a one-time initial password returned ONCE to the
    // admin to hand to the merchant; an existing email is just granted the persona.
    let login: { email: string; password: string | null; existing: boolean } | null = null;
    try {
      const existing = await rows<{ id: string }>("auth", `SELECT id::text FROM users WHERE email = $1`, [body.contact_email]);
      let userId: string;
      let tempPassword: string | null = null;
      if (existing.length) {
        userId = existing[0].id;
      } else {
        tempPassword = generatePassword();
        const created = await rows<{ id: string }>("auth", `
          INSERT INTO users (id, email, full_name, password_hash, status)
          VALUES (gen_random_uuid(), $1, $2, $3, 'active') RETURNING id::text
        `, [body.contact_email, body.brand_name || body.legal_name, hashPassword(tempPassword)]);
        userId = created[0].id;
      }
      // Ensure a MERCHANT persona scoped to this merchant (idempotent).
      // Cross-service merchant identity is the merchant_code (varchar), not the uuid
      // PK — scope_id MUST be the code or every merchant-scoped query returns nothing.
      await rows("iam", `
        INSERT INTO user_personas (id, user_id, persona_kind, scope_id, scope_label, is_primary, granted_by)
        SELECT gen_random_uuid(), $1::uuid, 'MERCHANT', $2, $3, true, $4
        WHERE NOT EXISTS (
          SELECT 1 FROM user_personas WHERE user_id = $1::uuid AND persona_kind = 'MERCHANT' AND scope_id = $2
        )
      `, [userId, res[0].merchant_code, `${res[0].merchant_code} — ${body.legal_name}`, s.email]);
      login = { email: body.contact_email, password: tempPassword, existing: existing.length > 0 };
    } catch { /* non-fatal: the merchant exists even if login provisioning fails */ }

    return NextResponse.json({ ...res[0], login });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
