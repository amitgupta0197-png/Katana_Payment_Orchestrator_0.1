// Persona policy (PRODUCT_VISION §3.1):
//   SUPER_ADMIN — list all; create.
//   PROVIDER    — read own row only.
//   MERCHANT    — forbidden (middleware also blocks, but defense-in-depth).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { hashPassword, generatePassword } from "@/lib/password";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;

  const tenant = "tenant-default";
  try {
    const params: unknown[] = [tenant];
    let where = "p.tenant_id = $1";
    if (s.persona === "PROVIDER") {
      where += " AND p.id = $2::uuid";
      params.push(s.scope_id);
    }
    const providers = await rows<any>("provider", `
      SELECT p.id, p.tenant_id, p.code, p.legal_name, p.contact_email::text AS contact_email,
             COALESCE(p.contact_phone,'') AS contact_phone, p.kind,
             p.kyc_status, p.status, p.settlement_currency,
             COALESCE(p.bank_account_no,'') AS bank_account_no,
             COALESCE(p.bank_ifsc,'') AS bank_ifsc,
             p.created_at,
             (SELECT COUNT(*)::int FROM provider_users u WHERE u.provider_id = p.id) AS user_count,
             (SELECT COUNT(*)::int FROM provider_kyc_documents d WHERE d.provider_id = p.id) AS doc_count,
             (SELECT COUNT(*)::int FROM provider_merchant_mappings m WHERE m.provider_id = p.id) AS merchant_count
        FROM providers p
       WHERE ${where}
       ORDER BY p.created_at DESC LIMIT 200
    `, params);
    return NextResponse.json({ providers });
  } catch (err) {
    const e = pgError(err);
    return NextResponse.json(e.body, { status: e.status });
  }
}

const createSchema = z.object({
  code: z.string().min(2).max(60),
  legal_name: z.string().min(2).max(255),
  contact_email: z.string().email(),
  contact_phone: z.string().optional(),
  kind: z.enum(["PROVIDER","AGENT","PARTNER","FRANCHISE"]).default("PROVIDER"),
  bank_account_no: z.string().optional(),
  bank_ifsc: z.string().optional(),
  settlement_currency: z.string().default("INR"),
  // One-shot onboarding: also provision the sign-ins/entities tied to this
  // provider. Banker = the provider wearing its DT hat (banker_id = provider
  // code); branch = a merchant mapped under this provider (merchant==branch,
  // display-only rename) whose processed transactions settle at branch level.
  create_provider_login: z.boolean().optional(),
  create_banker_login: z.boolean().optional(),
  banker_email: z.string().email().optional(),          // defaults to contact_email
  initial_branch: z.object({
    merchant_code: z.string().trim().min(2).max(60),
    legal_name: z.string().trim().min(2).max(255),
    contact_email: z.string().email().optional(),        // defaults to contact_email
  }).optional(),
});

// Create-or-reuse an auth user; returns the one-time password only when newly created.
async function ensureUser(email: string, fullName: string): Promise<{ userId: string; password: string | null; existing: boolean }> {
  const existing = await rows<{ id: string }>("auth", `SELECT id::text FROM users WHERE email = $1`, [email]);
  if (existing.length) return { userId: existing[0].id, password: null, existing: true };
  const password = generatePassword();
  const created = await rows<{ id: string }>("auth", `
    INSERT INTO users (id, email, full_name, password_hash, status)
    VALUES (gen_random_uuid(), $1, $2, $3, 'active') RETURNING id::text
  `, [email, fullName, hashPassword(password)]);
  return { userId: created[0].id, password, existing: false };
}

// Idempotently grant a persona scoped to scope_id. Only the user's FIRST persona
// is primary — user_personas_one_primary allows a single is_primary row per user,
// so a shared email (e.g. provider + banker on the same address) gets the extra
// grants as secondary personas (login uses the primary; others listed in all_personas).
async function ensurePersona(userId: string, kind: string, scopeId: string, scopeLabel: string, grantedBy: string) {
  await rows("iam", `
    INSERT INTO user_personas (id, user_id, persona_kind, scope_id, scope_label, is_primary, granted_by)
    SELECT gen_random_uuid(), $1::uuid, $2, $3, $4,
           NOT EXISTS (SELECT 1 FROM user_personas WHERE user_id = $1::uuid AND is_primary),
           $5
    WHERE NOT EXISTS (
      SELECT 1 FROM user_personas WHERE user_id = $1::uuid AND persona_kind = $2 AND scope_id = $3
    )
  `, [userId, kind, scopeId, scopeLabel, grantedBy]);
}

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;

  const tenant = req.headers.get("x-tenant-id") ?? "tenant-default";
  let body;
  try { body = createSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const res = await rows<any>("provider", `
      INSERT INTO providers (tenant_id, code, legal_name, contact_email, contact_phone, kind,
                             bank_account_no, bank_ifsc, settlement_currency, kyc_status, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', 'ACTIVE')
      ON CONFLICT (tenant_id, code) DO UPDATE SET
        legal_name = EXCLUDED.legal_name, contact_email = EXCLUDED.contact_email,
        contact_phone = EXCLUDED.contact_phone, updated_at = now()
      RETURNING id, code, legal_name, kyc_status, status, created_at
    `, [tenant, body.code, body.legal_name, body.contact_email, body.contact_phone ?? null, body.kind,
        body.bank_account_no ?? null, body.bank_ifsc ?? null, body.settlement_currency]);
    const provider = res[0];

    // Optional one-shot provisioning. Each block is non-fatal: the provider row
    // exists even if a login step fails; failures are reported back per-item.
    const provisioned: Record<string, unknown> = {};

    if (body.create_provider_login) {
      try {
        const u = await ensureUser(body.contact_email, body.legal_name);
        await ensurePersona(u.userId, "PROVIDER", provider.id, body.code, g.session.email);
        provisioned.provider_login = { email: body.contact_email, password: u.password, existing: u.existing };
      } catch (e) { provisioned.provider_login = { error: (e as Error).message }; }
    }

    if (body.create_banker_login) {
      const email = body.banker_email || body.contact_email;
      try {
        const u = await ensureUser(email, `${body.code} — DT Banker`);
        // banker_id is the provider CODE — the id dt_purchases/dt_refill_requests key by.
        await ensurePersona(u.userId, "BANKER", body.code, `${body.code} — DT Banker`, g.session.email);
        provisioned.banker_login = { banker_id: body.code, email, password: u.password, existing: u.existing };
      } catch (e) { provisioned.banker_login = { error: (e as Error).message }; }
    }

    if (body.initial_branch) {
      const b = body.initial_branch;
      const email = b.contact_email || body.contact_email;
      try {
        const m = await rows<{ id: string; merchant_code: string }>("merchant", `
          INSERT INTO merchants (tenant_id, merchant_code, legal_name, contact_email, stage)
          VALUES ($1, $2, $3, $4, 'APPLICATION')
          ON CONFLICT (tenant_id, merchant_code) DO UPDATE SET legal_name = EXCLUDED.legal_name, updated_at = now()
          RETURNING id, merchant_code
        `, [tenant, b.merchant_code, b.legal_name, email]);
        await rows("provider", `
          INSERT INTO provider_merchant_mappings (provider_id, merchant_id, mapped_by)
          VALUES ($1::uuid, $2::uuid, $3)
          ON CONFLICT (provider_id, merchant_id) DO NOTHING
        `, [provider.id, m[0].id, g.session.email]).catch(() => {});
        const u = await ensureUser(email, b.legal_name);
        await ensurePersona(u.userId, "MERCHANT", m[0].merchant_code, `${m[0].merchant_code} — ${b.legal_name}`, g.session.email);
        provisioned.branch = {
          merchant_code: m[0].merchant_code,
          login: { email, password: u.password, existing: u.existing },
        };
      } catch (e) { provisioned.branch = { error: (e as Error).message }; }
    }

    return NextResponse.json({ ...provider, ...provisioned });
  } catch (err) {
    const e = pgError(err);
    return NextResponse.json(e.body, { status: e.status });
  }
}
