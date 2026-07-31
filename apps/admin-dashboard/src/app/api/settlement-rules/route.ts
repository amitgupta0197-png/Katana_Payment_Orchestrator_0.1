// /api/settlement-rules — the Katana settlement commission rule engine (admin-managed).
//   GET  — list rules. SUPER_ADMIN: all (optional ?provider= &branch= &active=1).
//          PROVIDER: rules that can apply to it (its own + globals), read-only.
//   POST — create a rule (SUPER_ADMIN only). Never edits in place: the previous rule for
//          the SAME scope is end-dated and the new one gets version+1, so historical
//          settlements keep the pricing they were raised under (BRD §6).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);
  const where: string[] = []; const args: unknown[] = [];

  try {
    if (s.persona === "PROVIDER") {
      args.push(s.scope_id);
      where.push(`(provider_id IS NULL OR provider_id = $${args.length}::uuid)`);
    } else {
      const fp = url.searchParams.get("provider");
      if (fp) { args.push(fp); where.push(`(provider_id IS NULL OR provider_id = $${args.length}::uuid)`); }
    }
    if (url.searchParams.get("active") === "1")
      where.push(`effective_from <= now() AND (effective_to IS NULL OR effective_to > now())`);

    const list = await rows("provider", `
      SELECT r.id::text, r.provider_id::text, r.merchant_key, r.upline_bps, r.katana_bps, r.downline_bps,
             r.fixed_fee::float AS fixed_fee, r.gst_bps, r.min_charge::float AS min_charge,
             r.max_charge::float AS max_charge, r.currency, r.effective_from, r.effective_to,
             r.version, r.reason, r.created_by, r.approved_by, r.created_at,
             p.legal_name AS provider_name, p.code AS provider_code
        FROM provider_settlement_rules r
        LEFT JOIN providers p ON p.id = r.provider_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY r.effective_from DESC LIMIT 300
    `, args);
    return NextResponse.json({ rules: list });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  provider_id: z.string().uuid().nullish(),   // null = global default
  merchant_key: z.string().max(120).nullish(),
  upline_bps: z.coerce.number().int().min(0).max(10000).default(0),
  katana_bps: z.coerce.number().int().min(0).max(10000).default(0),
  downline_bps: z.coerce.number().int().min(0).max(10000).default(0),
  fixed_fee: z.coerce.number().min(0).default(0),
  gst_bps: z.coerce.number().int().min(0).max(10000).default(0),
  min_charge: z.coerce.number().min(0).nullish(),
  max_charge: z.coerce.number().min(0).nullish(),
  effective_from: z.string().datetime({ offset: true }).optional(),  // default now
  reason: z.string().min(3).max(500),          // BRD: every pricing change needs a reason
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;

  let body: z.infer<typeof createSchema>;
  try { body = createSchema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  const providerId = body.provider_id ?? null;
  const merchantKey = body.merchant_key?.trim() || null;
  const from = body.effective_from ?? new Date().toISOString();

  try {
    // End-date the currently-open rule for the SAME scope and take its version.
    const prev = await rows<{ id: string; version: number }>("provider", `
      UPDATE provider_settlement_rules
         SET effective_to = $3::timestamptz
       WHERE provider_id IS NOT DISTINCT FROM $1::uuid
         AND merchant_key IS NOT DISTINCT FROM $2
         AND (effective_to IS NULL OR effective_to > $3::timestamptz)
      RETURNING id::text, version
    `, [providerId, merchantKey, from]);
    const version = prev.length ? Math.max(...prev.map((p) => p.version)) + 1 : 1;

    const ins = await rows<{ id: string }>("provider", `
      INSERT INTO provider_settlement_rules
        (provider_id, merchant_key, upline_bps, katana_bps, downline_bps, fixed_fee, gst_bps,
         min_charge, max_charge, effective_from, version, reason, created_by, approved_by)
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12,$13,$13)
      RETURNING id::text
    `, [providerId, merchantKey, body.upline_bps, body.katana_bps, body.downline_bps,
        body.fixed_fee, body.gst_bps, body.min_charge ?? null, body.max_charge ?? null,
        from, version, body.reason, s.email]);

    // BRD: record old rule → new rule with who/why.
    if (providerId) await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
      VALUES ($1::uuid, $2, 'provider.settlement_rule.changed', $3::jsonb)
    `, [providerId, s.email, JSON.stringify({ superseded: prev.map((p) => p.id), new_rule: ins[0].id, version, reason: body.reason })]).catch(() => {});

    return NextResponse.json({ rule_id: ins[0].id, version, superseded: prev.length });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
