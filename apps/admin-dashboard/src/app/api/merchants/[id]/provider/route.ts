// Provider attribution for a single merchant (PRODUCT_VISION §3.1/§3.3).
// Lets you assign an already-onboarded merchant to a provider so we can trace
//   - which provider sourced the merchant (provider_merchant_mappings row), and
//   - who onboarded / assigned it (merchant_activity actor timeline).
//
// Persona policy:
//   SUPER_ADMIN — read attribution; assign/unassign any provider.
//   PROVIDER    — read attribution for mapped merchants only.
//   MERCHANT    — read own attribution only.
//
// provider_merchant_mappings.merchant_id is the merchant UUID (same as the [id]
// route param). Columns: (provider_id, merchant_id, status, mapped_by, mapped_at).
// merchant_code is only resolved for display.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

async function resolveMerchant(id: string) {
  const m = await rows<any>("merchant",
    `SELECT id, merchant_code FROM merchants WHERE id = $1::uuid AND tenant_id = 'tenant-default'`, [id]);
  return m[0] as { id: string; merchant_code: string } | undefined;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  try {
    const merchant = await resolveMerchant(id);
    if (!merchant) return NextResponse.json({ error: "not found" }, { status: 404 });

    // Scope checks mirror the merchant detail route.
    if (s.persona === "MERCHANT" && s.scope_id !== id)
      return NextResponse.json({ error: "merchants can only read own attribution" }, { status: 403 });
    if (s.persona === "PROVIDER") {
      const mapped = await resolveProviderMerchants(s);
      if (!mapped.includes(id) && !mapped.includes(merchant.merchant_code))
        return NextResponse.json({ error: "merchant not mapped to your provider" }, { status: 403 });
    }

    const mappings = await rows<any>("provider", `
      SELECT m.provider_id::text AS provider_id, p.code, p.legal_name, p.kind,
             m.status, COALESCE(m.mapped_by,'') AS mapped_by, m.mapped_at
        FROM provider_merchant_mappings m
        JOIN providers p ON p.id = m.provider_id
       WHERE m.merchant_id = $1::uuid
       ORDER BY m.mapped_at ASC
    `, [id]);

    // Who onboarded the merchant (first APPLICATION_SUBMITTED actor) for reference.
    const onboarded = await rows<any>("merchant", `
      SELECT actor, created_at
        FROM merchant_activity
       WHERE merchant_id = $1::uuid AND action = 'APPLICATION_SUBMITTED'
       ORDER BY created_at ASC LIMIT 1
    `, [id]).catch(() => []);

    return NextResponse.json({
      merchant_code: merchant.merchant_code,
      mappings,
      onboarded_by: onboarded[0]?.actor ?? "",
      onboarded_at: onboarded[0]?.created_at ?? null,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const assignSchema = z.object({
  provider_id: z.string().uuid(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  let body;
  try { body = assignSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const merchant = await resolveMerchant(id);
    if (!merchant) return NextResponse.json({ error: "not found" }, { status: 404 });

    const prov = await rows<any>("provider",
      `SELECT id, code FROM providers WHERE id = $1::uuid AND tenant_id = 'tenant-default'`, [body.provider_id]);
    if (!prov.length) return NextResponse.json({ error: "provider not found" }, { status: 404 });

    await rows("provider", `
      INSERT INTO provider_merchant_mappings (provider_id, merchant_id, mapped_by)
      VALUES ($1::uuid, $2::uuid, $3)
      ON CONFLICT (provider_id, merchant_id) DO UPDATE SET status = 'ACTIVE', mapped_by = EXCLUDED.mapped_by
    `, [body.provider_id, id, s.email]);

    // Traceability: who assigned the merchant to this provider, and when.
    await rows("merchant", `
      INSERT INTO merchant_activity (merchant_id, action, actor, payload)
      VALUES ($1::uuid, 'PROVIDER_ASSIGNED', $2, $3::jsonb)
    `, [id, s.email, JSON.stringify({ provider_id: body.provider_id, provider_code: prov[0].code })])
      .catch(() => {});

    return NextResponse.json({ ok: true, provider_id: body.provider_id, provider_code: prov[0].code });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  const url = new URL(req.url);
  const providerId = url.searchParams.get("provider_id");
  if (!providerId) return NextResponse.json({ error: "provider_id query param required" }, { status: 400 });
  try {
    await rows("provider", `
      DELETE FROM provider_merchant_mappings WHERE provider_id = $1::uuid AND merchant_id = $2::uuid
    `, [providerId, id]);
    await rows("merchant", `
      INSERT INTO merchant_activity (merchant_id, action, actor, payload)
      VALUES ($1::uuid, 'PROVIDER_UNASSIGNED', $2, $3::jsonb)
    `, [id, s.email, JSON.stringify({ provider_id: providerId })]).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
