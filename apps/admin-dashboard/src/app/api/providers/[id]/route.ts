// GET / PATCH a single provider.
// SUPER_ADMIN: full read + update kyc_status / status / bank.
// PROVIDER:    read own only; update bank fields only.
//
// BRD §4 (P0): KYC approval / rejection and TERMINATION require maker-checker.
//   These actions enqueue a maker_checker_requests row (status PENDING)
//   instead of mutating providers directly. A second SUPER_ADMIN applies
//   the change via /api/admin/maker-checker.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { publish } from "@/lib/events";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  if (s.persona === "PROVIDER" && s.scope_id !== id)
    return NextResponse.json({ error: "providers can only read own row" }, { status: 403 });

  try {
    const provider = await rows<any>("provider", `
      SELECT p.id::text, p.tenant_id, p.code, p.legal_name,
             p.contact_email::text AS contact_email, COALESCE(p.contact_phone,'') AS contact_phone,
             p.kind, p.kyc_status, p.status, p.settlement_currency,
             COALESCE(p.bank_account_no,'') AS bank_account_no,
             COALESCE(p.bank_ifsc,'') AS bank_ifsc,
             p.created_at, p.updated_at
        FROM providers p WHERE p.id = $1::uuid
    `, [id]);
    if (!provider.length) return NextResponse.json({ error: "not found" }, { status: 404 });

    const users = await rows<any>("provider", `
      SELECT id::text, email, COALESCE(name,'') AS name, role, created_at
        FROM provider_users WHERE provider_id = $1::uuid ORDER BY created_at DESC
    `, [id]).catch(() => []);
    const docs = await rows<any>("provider", `
      SELECT id::text, doc_type, uri, sha256,
             COALESCE(verified_at::text,'') AS verified_at,
             COALESCE(verified_by,'') AS verified_by, created_at
        FROM provider_kyc_documents WHERE provider_id = $1::uuid ORDER BY created_at DESC
    `, [id]).catch(() => []);
    const commission = await rows<any>("provider", `
      SELECT id::text, rule_kind, rate_bps, fixed_fee, currency, valid_from, valid_to
        FROM provider_commission_rules WHERE provider_id = $1::uuid ORDER BY valid_from DESC
    `, [id]).catch(() => []);
    // NB: this table's columns are status / mapped_at (not relation / created_at).
    // Selecting the wrong names threw, and the silent catch below swallowed it —
    // making every provider show "0 merchants" even with mappings present.
    const mappings = await rows<any>("provider", `
      SELECT id::text, merchant_id::text AS merchant_id, status AS relation, mapped_at AS created_at
        FROM provider_merchant_mappings WHERE provider_id = $1::uuid ORDER BY mapped_at DESC
    `, [id]).catch(() => []);

    // Enrich each mapping with the merchant's name/code. merchants live in a
    // separate service DB (no cross-DB join), so resolve them in one batch query.
    // merchant_id is the merchant UUID on newer rows; very old rows may hold the
    // merchant_code — match on either so both resolve.
    if (mappings.length) {
      const keys = mappings.map((m: any) => m.merchant_id);
      const merchants = await rows<any>("merchant", `
        SELECT id::text, merchant_code, legal_name, COALESCE(brand_name,'') AS brand_name
          FROM merchants WHERE id::text = ANY($1::text[]) OR merchant_code = ANY($1::text[])
      `, [keys]).catch(() => []);
      const byKey = new Map<string, any>();
      for (const mc of merchants) { byKey.set(mc.id, mc); byKey.set(mc.merchant_code, mc); }
      for (const m of mappings) {
        const mc = byKey.get(m.merchant_id);
        m.merchant_code = mc?.merchant_code ?? null;
        m.merchant_name = mc ? (mc.brand_name || mc.legal_name) : null;
        // The merchant detail page is keyed by UUID; resolve it so the link works
        // even for legacy rows whose merchant_id holds the merchant_code.
        m.merchant_uuid = mc?.id ?? m.merchant_id;
      }
    }
    const auditLog = await rows<any>("provider", `
      SELECT id, actor, action, before_state, after_state, occurred_at
        FROM provider_audit_logs WHERE provider_id = $1::uuid
        ORDER BY occurred_at DESC LIMIT 50
    `, [id]).catch(() => []);
    const pendingApprovals = await rows<any>("provider", `
      SELECT request_id::text, action, payload, maker_email, status, created_at
        FROM maker_checker_requests
       WHERE resource_type = 'provider' AND resource_id = $1 AND status = 'PENDING'
       ORDER BY created_at DESC
    `, [id]).catch(() => []);

    return NextResponse.json({
      provider: provider[0], users, docs, commission, mappings,
      audit_log: auditLog, pending_approvals: pendingApprovals,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const patchSchema = z.object({
  kyc_status: z.enum(["PENDING","IN_REVIEW","APPROVED","REJECTED","EXPIRED"]).optional(),
  status: z.enum(["ACTIVE","SUSPENDED","TERMINATED"]).optional(),
  bank_account_no: z.string().optional(),
  bank_ifsc: z.string().optional(),
  contact_phone: z.string().optional(),
  notes: z.string().optional(),
});

// Which transitions are sensitive enough to require a second approver.
function isSensitive(fields: Record<string, unknown>): { action: string; payload: any } | null {
  if (fields.kyc_status === "APPROVED") return { action: "provider.kyc.approve", payload: fields };
  if (fields.kyc_status === "REJECTED") return { action: "provider.kyc.reject",  payload: fields };
  if (fields.status     === "TERMINATED") return { action: "provider.status.terminate", payload: fields };
  return null;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  let body;
  try { body = patchSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  // Persona-restricted field allowlists.
  const allowed = s.persona === "SUPER_ADMIN"
    ? new Set(Object.keys(patchSchema.shape))
    : new Set(["bank_account_no", "bank_ifsc", "contact_phone"]);

  if (s.persona === "PROVIDER" && s.scope_id !== id)
    return NextResponse.json({ error: "providers can only update own row" }, { status: 403 });

  const fields = Object.fromEntries(
    Object.entries(body).filter(([k, v]) => allowed.has(k) && v !== undefined && k !== "notes"),
  );
  if (Object.keys(fields).length === 0)
    return NextResponse.json({ error: "no fields you may edit were supplied" }, { status: 400 });

  // Maker-checker gate (SUPER_ADMIN only — provider has no sensitive verbs anyway).
  const sensitive = s.persona === "SUPER_ADMIN" ? isSensitive(fields) : null;
  if (sensitive) {
    try {
      // Reject if there's already a pending request for the same action on this provider.
      const dupe = await rows<any>("provider", `
        SELECT request_id::text FROM maker_checker_requests
         WHERE resource_type = 'provider' AND resource_id = $1
           AND action = $2 AND status = 'PENDING' LIMIT 1
      `, [id, sensitive.action]).catch(() => []);
      if (dupe.length)
        return NextResponse.json({ error: "a pending approval for this action already exists", request_id: dupe[0].request_id }, { status: 409 });

      const ins = await rows<{ request_id: string }>("provider", `
        INSERT INTO maker_checker_requests
          (resource_type, resource_id, action, payload, maker_id, maker_email)
        VALUES ('provider', $1, $2, $3::jsonb, $4, $5)
        RETURNING request_id::text
      `, [id, sensitive.action, JSON.stringify({ ...sensitive.payload, notes: body.notes }), s.user_id, s.email]);

      await publish({
        eventType: "maker_checker.requested",
        producer: "provider_mgmt",
        entityType: "provider", entityId: id, actorId: s.user_id,
        payload: { request_id: ins[0].request_id, action: sensitive.action, fields },
      });

      return NextResponse.json({
        queued_for_approval: true,
        request_id: ins[0].request_id,
        action: sensitive.action,
        message: "Awaiting a second SUPER_ADMIN to approve at /admin/maker-checker",
      }, { status: 202 });
    } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
  }

  // Non-sensitive update — apply immediately.
  try {
    const before = await rows<any>("provider", `
      SELECT kyc_status, status, COALESCE(bank_account_no,'') AS bank_account_no,
             COALESCE(bank_ifsc,'') AS bank_ifsc, COALESCE(contact_phone,'') AS contact_phone
        FROM providers WHERE id = $1::uuid
    `, [id]);
    if (!before.length) return NextResponse.json({ error: "not found" }, { status: 404 });

    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      args.push(v);
      sets.push(`${k} = $${args.length}`);
    }
    args.push(id);
    const res = await rows<any>("provider", `
      UPDATE providers SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $${args.length}::uuid
       RETURNING id::text, code, kyc_status, status, updated_at
    `, args);
    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, before_state, after_state)
      VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb)
    `, [id, s.email, "provider.updated", JSON.stringify(before[0]), JSON.stringify(fields)]).catch(() => {});
    return NextResponse.json(res[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
