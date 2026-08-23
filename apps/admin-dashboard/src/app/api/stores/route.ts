// /api/stores — merchant stores (BRD module 02).
//   GET  — every store with its merchant and current live endpoint. ?merchant=<provider uuid>
//   POST — create a store under a merchant { provider_id, code, name, city?, address? }
//
// "Merchant" here is a row in `providers` (persona PROVIDER) — see the naming note at the
// top of tools/migrations/provider/0015_qr_switch_model.sql. A store belongs to a merchant;
// the banker enters the picture only through the QR that is allocated to the store.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { rows, pgError } from "@/lib/pg";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "OPERATOR"]);
  if ("response" in g) return g.response;

  const merchantId = new URL(req.url).searchParams.get("merchant")?.trim() || null;

  try {
    const stores = await rows("provider", `
      SELECT s.id::text        AS store_id,
             s.code            AS store_code,
             s.name            AS store_name,
             s.city, s.address, s.status, s.multi_endpoint,
             s.provider_id::text AS provider_id,
             p.legal_name      AS merchant_name,
             p.code            AS merchant_code,
             a.id::text        AS assignment_id,
             q.id::text        AS qr_id,
             q.upi_id          AS qr_upi_id,
             q.provider        AS qr_provider,
             a.banker_code,
             a.assigned_at,
             (SELECT COUNT(*)::int FROM qr_switch_events e WHERE e.store_id = s.id) AS switch_count
        FROM merchant_store s
        JOIN providers p ON p.id = s.provider_id
        LEFT JOIN merchant_store_qr_assignment a ON a.store_id = s.id AND a.is_active
        LEFT JOIN banker_qr q ON q.id = a.qr_id
       WHERE ($1::uuid IS NULL OR s.provider_id = $1::uuid)
       ORDER BY p.legal_name, s.code
       LIMIT 500
    `, [merchantId]);
    return NextResponse.json({ stores });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;

  let body: { provider_id?: string; code?: string; name?: string; city?: string; address?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON body required" }, { status: 400 }); }

  const providerId = String(body.provider_id ?? "").trim();
  const code = String(body.code ?? "").trim().toUpperCase();
  const name = String(body.name ?? "").trim();
  if (!providerId || !code || !name)
    return NextResponse.json({ error: "provider_id, code and name are required" }, { status: 400 });

  try {
    const exists = await rows<{ id: string }>("provider",
      `SELECT id::text FROM providers WHERE id = $1::uuid`, [providerId]).catch(() => []);
    if (!exists.length) return NextResponse.json({ error: "merchant not found" }, { status: 404 });

    // UNIQUE (provider_id, code): store codes are the merchant's own labels, so they only
    // have to be unique within that merchant, not across the platform.
    const ins = await rows<{ id: string }>("provider", `
      INSERT INTO merchant_store (provider_id, code, name, city, address, created_by)
      VALUES ($1::uuid, $2, $3, $4, $5, $6)
      ON CONFLICT (provider_id, code) DO NOTHING
      RETURNING id::text
    `, [providerId, code, name, String(body.city ?? "").trim() || null,
        String(body.address ?? "").trim() || null, s.email]);

    if (!ins.length)
      return NextResponse.json({ error: `store code ${code} already exists for this merchant` }, { status: 409 });

    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
      VALUES ($1::uuid, $2, 'store.created', $3::jsonb)
    `, [providerId, s.email, JSON.stringify({ store_id: ins[0].id, code, name })]).catch(() => {});

    return NextResponse.json({ ok: true, store_id: ins[0].id });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
