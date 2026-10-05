// Storage for partners and their sub-merchants (vendorGateway 0044). The rules are in ./rules.
//
// Sub-merchant status changes go through actOnSub and are logged by the database (a trigger on
// partner_sub_merchants writes partner_events); everything else a person changes is logged here.

import { randomBytes } from "crypto";
import { rows } from "@/lib/pg";
import { openText, sealText } from "@/lib/sealed-text";
import { newWebhookSecret } from "@/lib/webhook-v2";
import { getProviderFlow } from "@/lib/payin-flow-store";
import {
  cleanSubMerchant, flowsWithinPartner, limitsProblem, moveSub, newSubCode,
  type FieldProblem, type PartnerStatus, type SubAction, type SubFlows, type SubMerchantInput, type SubStatus,
} from "@/lib/partner/rules";

export interface PartnerRow {
  id: string;
  provider_id: string;
  code: string;
  name: string;
  status: PartnerStatus;
  exclusive: boolean;
  auto_approve: boolean;
  own_gateway: string | null;
  webhook_url: string | null;
  webhook_events: "ALL" | "PAID_ONLY";
  has_webhook_secret: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SubMerchantRow {
  id: string;
  partner_id: string;
  sub_code: string;
  external_id: string;
  legal_name: string;
  display_name: string | null;
  business_type: string | null;
  category: string | null;
  pan: string | null;
  gstin: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  flows: SubFlows;
  min_amount: number | null;
  max_amount: number | null;
  daily_amount: number | null;
  status: SubStatus;
  status_reason: string | null;
  created_via: "API" | "PORTAL" | "STAFF";
  created_by: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A field the caller sent is wrong (400), or the thing it names already exists (409). */
export class PartnerInputError extends Error {
  constructor(readonly problem: FieldProblem, readonly status = 400, readonly code = "INVALID_REQUEST") { super(problem.message); }
}

const partnerCols = (t = "") => `${t}id::text AS id, ${t}provider_id, ${t}code, ${t}name, ${t}status, ${t}exclusive, ${t}auto_approve,
  ${t}own_gateway, ${t}webhook_url, ${t}webhook_events, (${t}webhook_secret IS NOT NULL) AS has_webhook_secret, ${t}created_by,
  ${t}created_at, ${t}updated_at`;
const PARTNER_COLS = partnerCols();
const SUB_COLS = `id::text, partner_id::text, sub_code, external_id, legal_name, display_name, business_type, category, pan, gstin,
  email, phone, website, address, flows, min_amount::float AS min_amount, max_amount::float AS max_amount,
  daily_amount::float AS daily_amount, status, status_reason, created_via, created_by, reviewed_by, reviewed_at, created_at, updated_at`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Before 0044 is applied there are no partners. */
const missing = (err: unknown) => ["42P01", "42703"].includes((err as { code?: string }).code ?? "");

export async function logPartnerEvent(partnerId: string, action: string, actor: string, detail: Record<string, unknown> = {}, subId: string | null = null): Promise<void> {
  await rows("vendorGateway", `
    INSERT INTO partner_events (partner_id, sub_merchant_id, action, detail, actor) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5)
  `, [partnerId, subId, action, JSON.stringify(detail), actor]);
}

// ── Partners ─────────────────────────────────────────────────────────────────────

export interface PartnerListRow extends PartnerRow {
  subs_active: number; subs_pending: number; subs_total: number;
  today_orders: number; today_paid_amount: number;
}

export async function listPartners(): Promise<PartnerListRow[]> {
  return rows<PartnerListRow>("vendorGateway", `
    SELECT ${partnerCols("p.")},
           COALESCE(s.active, 0) AS subs_active, COALESCE(s.pending, 0) AS subs_pending, COALESCE(s.total, 0) AS subs_total,
           COALESCE(o.orders, 0) AS today_orders, COALESCE(o.paid, 0)::float AS today_paid_amount
      FROM partners p
      LEFT JOIN (SELECT partner_id, COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
                        COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending, COUNT(*)::int AS total
                   FROM partner_sub_merchants GROUP BY 1) s ON s.partner_id = p.id
      LEFT JOIN (SELECT partner_id, COUNT(*)::int AS orders, SUM(amount) FILTER (WHERE status = 'SUCCESS') AS paid
                   FROM vendor_payin_orders
                  WHERE partner_id IS NOT NULL AND livemode
                    AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
                  GROUP BY 1) o ON o.partner_id = p.id
     ORDER BY p.name
  `).catch((e) => { if (missing(e)) return []; throw e; });
}

export async function getPartner(id: string): Promise<PartnerRow | null> {
  if (!UUID.test(id)) return null;
  return (await rows<PartnerRow>("vendorGateway", `SELECT ${PARTNER_COLS} FROM partners WHERE id = $1::uuid`, [id])
    .catch((e) => { if (missing(e)) return []; throw e; }))[0] ?? null;
}

/** The partner record of a merchant (a `providers` id), or null when the merchant is not a partner. */
export async function partnerForProvider(providerId: string | null | undefined): Promise<PartnerRow | null> {
  if (!providerId) return null;
  return (await rows<PartnerRow>("vendorGateway", `SELECT ${PARTNER_COLS} FROM partners WHERE provider_id = $1`, [providerId])
    .catch((e) => { if (missing(e)) return []; throw e; }))[0] ?? null;
}

export interface NewPartner { provider_id: string; code: string; name?: string | null; exclusive?: boolean; auto_approve?: boolean; own_gateway?: string | null }

/** Make an existing merchant a partner. */
export async function createPartner(p: NewPartner, by: string): Promise<PartnerRow> {
  const prov = await rows<{ legal_name: string | null; code: string | null }>("provider",
    `SELECT legal_name, code FROM providers WHERE id = $1::uuid`, [p.provider_id]).catch(() => []);
  if (!prov.length) throw new PartnerInputError({ field: "provider_id", message: "no merchant with that id" }, 404, "NOT_FOUND");
  if (await partnerForProvider(p.provider_id))
    throw new PartnerInputError({ field: "provider_id", message: "this merchant is already a partner" }, 409, "PARTNER_EXISTS");
  const taken = await rows("vendorGateway", `SELECT 1 FROM partners WHERE code = $1`, [p.code]);
  if (taken.length) throw new PartnerInputError({ field: "code", message: "that partner code is taken" }, 409, "CODE_TAKEN");
  const r = await rows<PartnerRow>("vendorGateway", `
    INSERT INTO partners (provider_id, code, name, exclusive, auto_approve, own_gateway, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING ${PARTNER_COLS}
  `, [p.provider_id, p.code, p.name?.trim() || prov[0].legal_name || prov[0].code || p.code, p.exclusive ?? true,
      p.auto_approve ?? false, p.own_gateway?.trim().toUpperCase() || null, by]);
  await logPartnerEvent(r[0].id, "PARTNER", by, { created: true, exclusive: r[0].exclusive, auto_approve: r[0].auto_approve, own_gateway: r[0].own_gateway });
  return r[0];
}

export interface PartnerPatch { name?: string; status?: PartnerStatus; exclusive?: boolean; auto_approve?: boolean; own_gateway?: string | null }

export async function updatePartner(id: string, patch: PartnerPatch, by: string): Promise<PartnerRow | null> {
  const before = await getPartner(id);
  if (!before) return null;
  const r = await rows<PartnerRow>("vendorGateway", `
    UPDATE partners SET
      name = COALESCE($2, name), status = COALESCE($3, status), exclusive = COALESCE($4, exclusive),
      auto_approve = COALESCE($5, auto_approve),
      own_gateway = CASE WHEN $6::boolean THEN $7 ELSE own_gateway END,
      updated_by = $8, updated_at = now()
     WHERE id = $1::uuid RETURNING ${PARTNER_COLS}
  `, [id, patch.name?.trim() || null, patch.status ?? null, patch.exclusive ?? null, patch.auto_approve ?? null,
      patch.own_gateway !== undefined, patch.own_gateway?.trim().toUpperCase() || null, by]);
  const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => (before as unknown as Record<string, unknown>)[k] !== v));
  if (Object.keys(changed).length) await logPartnerEvent(id, "PARTNER", by, { changed });
  return r[0] ?? null;
}

// ── Webhook ──────────────────────────────────────────────────────────────────────

export async function setPartnerWebhook(id: string, w: { url?: string | null; events?: "ALL" | "PAID_ONLY" }, by: string): Promise<PartnerRow | null> {
  const r = await rows<PartnerRow>("vendorGateway", `
    UPDATE partners SET
      webhook_url = CASE WHEN $2::boolean THEN $3 ELSE webhook_url END,
      webhook_events = COALESCE($4, webhook_events), updated_by = $5, updated_at = now()
     WHERE id = $1::uuid RETURNING ${PARTNER_COLS}
  `, [id, w.url !== undefined, w.url?.trim() || null, w.events ?? null, by]);
  if (r[0]) await logPartnerEvent(id, "WEBHOOK", by, { url: r[0].webhook_url, events: r[0].webhook_events });
  return r[0] ?? null;
}

/** A new signing secret, shown once. The old one stops working at once. */
export async function rotatePartnerSecret(id: string, by: string): Promise<string | null> {
  const secret = newWebhookSecret();
  const r = await rows("vendorGateway", `
    UPDATE partners SET webhook_secret = $2, updated_by = $3, updated_at = now() WHERE id = $1::uuid RETURNING 1
  `, [id, sealText(secret), by]);
  if (!r.length) return null;
  await logPartnerEvent(id, "WEBHOOK", by, { secret: "rotated" });
  return secret;
}

export async function partnerWebhookSecret(id: string): Promise<string | null> {
  if (!UUID.test(id)) return null;
  const r = await rows<{ s: string | null }>("vendorGateway", `SELECT webhook_secret AS s FROM partners WHERE id = $1::uuid`, [id]).catch(() => []);
  return openText(r[0]?.s)?.trim() || null;
}

// ── Sub-merchants ────────────────────────────────────────────────────────────────

async function partnerFlow(partner: PartnerRow): Promise<"P2P" | "INTENT" | "BOTH" | null> {
  const f = await getProviderFlow(partner.provider_id);
  return f.flow === "UNSET" ? null : f.flow;
}

/** A sub-merchant's flows must be ones the partner itself is on (its merchant's pay-in flow). */
async function assertFlowsWithinPartner(partner: PartnerRow, flows: SubFlows): Promise<void> {
  const merchantFlow = await partnerFlow(partner);
  if (!flowsWithinPartner(flows, merchantFlow))
    throw new PartnerInputError({ field: "flows", message: `the partner account is on ${merchantFlow} only, so its merchants can only be on ${merchantFlow}` });
}

export async function listSubs(partnerId: string, f: { status?: SubStatus | null; q?: string | null; limit?: number } = {}): Promise<SubMerchantRow[]> {
  const q = f.q?.trim() ? `%${f.q.trim().toLowerCase()}%` : null;
  return rows<SubMerchantRow>("vendorGateway", `
    SELECT ${SUB_COLS} FROM partner_sub_merchants
     WHERE partner_id = $1::uuid AND ($2::text IS NULL OR status = $2)
       AND ($3::text IS NULL OR lower(legal_name) LIKE $3 OR lower(COALESCE(display_name,'')) LIKE $3
            OR lower(external_id) LIKE $3 OR lower(sub_code) LIKE $3)
     ORDER BY created_at DESC LIMIT $4
  `, [partnerId, f.status ?? null, q, Math.min(Math.max(f.limit ?? 200, 1), 500)]);
}

/** A sub-merchant of this partner, by Katana's id (uuid or SM_…) or the partner's own id. */
export async function getSub(partnerId: string, ref: string): Promise<SubMerchantRow | null> {
  const r = await rows<SubMerchantRow>("vendorGateway", `
    SELECT ${SUB_COLS} FROM partner_sub_merchants
     WHERE partner_id = $1::uuid AND (sub_code = $2 OR external_id = $2 OR ($3::boolean AND id = $4::uuid))
     ORDER BY (sub_code = $2) DESC LIMIT 1
  `, [partnerId, ref, UUID.test(ref), UUID.test(ref) ? ref : "00000000-0000-0000-0000-000000000000"]);
  return r[0] ?? null;
}

export async function createSub(partner: PartnerRow, input: Partial<SubMerchantInput>, via: "API" | "PORTAL" | "STAFF", by: string): Promise<SubMerchantRow> {
  const c = cleanSubMerchant(input);
  if (!c.ok) throw new PartnerInputError(c.problem);
  const v = c.value as SubMerchantInput;
  const lp = limitsProblem(v);
  if (lp) throw new PartnerInputError(lp);
  // Not stated: the partner's own flow when it is on one only, else both.
  if (!input.flows) { const pf = await partnerFlow(partner); v.flows = pf === "P2P" || pf === "INTENT" ? pf : "BOTH"; }
  await assertFlowsWithinPartner(partner, v.flows ?? "BOTH");
  // A partner set to auto-approve has its merchants active at once; staff-made ones are too.
  const active = partner.auto_approve || via === "STAFF";
  const reviewer = via === "STAFF" ? by : partner.auto_approve ? "auto-approve" : null;
  const r = await rows<SubMerchantRow>("vendorGateway", `
    INSERT INTO partner_sub_merchants
      (partner_id, sub_code, external_id, legal_name, display_name, business_type, category, pan, gstin, email, phone,
       website, address, flows, min_amount, max_amount, daily_amount, status, created_via, created_by, updated_by,
       reviewed_by, reviewed_at)
    VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $20,
            $21, CASE WHEN $21::text IS NULL THEN NULL ELSE now() END)
    ON CONFLICT (partner_id, external_id) DO NOTHING
    RETURNING ${SUB_COLS}
  `, [partner.id, newSubCode(randomBytes(9).toString("hex")), v.external_id, v.legal_name, v.display_name ?? null,
      v.business_type ?? null, v.category ?? null, v.pan ?? null, v.gstin ?? null, v.email ?? null, v.phone ?? null,
      v.website ?? null, v.address ?? null, v.flows ?? "BOTH", v.min_amount ?? null, v.max_amount ?? null,
      v.daily_amount ?? null, active ? "ACTIVE" : "PENDING", via, by, reviewer]);
  if (!r.length) throw new PartnerInputError({ field: "external_id", message: `a sub-merchant with external_id ${v.external_id} already exists` }, 409, "SUB_MERCHANT_EXISTS");
  return r[0];
}

/** Fields that identify the business: a partner changing one on an active sub-merchant sends it back for review. */
const IDENTITY: (keyof SubMerchantInput)[] = ["legal_name", "pan", "gstin"];

/**
 * Change a sub-merchant's details. A partner changing its name, PAN or GSTIN while it is active
 * sends it back for review (unless the partner is set to auto-approve); staff changes do not.
 * external_id never changes: it is how the partner names the merchant.
 */
export async function updateSub(partner: PartnerRow, sub: SubMerchantRow, input: Partial<SubMerchantInput>, by: string, staff: boolean): Promise<SubMerchantRow> {
  const { external_id: _ignored, ...rest } = input;
  const c = cleanSubMerchant(rest, true);
  if (!c.ok) throw new PartnerInputError(c.problem);
  const v = c.value;
  const merged = { ...sub, ...v };
  // The PAN in a GSTIN is checked against the PAN the sub-merchant will have after this change.
  if (merged.pan && merged.gstin && merged.gstin.slice(2, 12) !== merged.pan)
    throw new PartnerInputError({ field: "gstin", message: "gstin was not issued to this PAN" });
  const lp = limitsProblem(merged);
  if (lp) throw new PartnerInputError(lp);
  if (v.flows) await assertFlowsWithinPartner(partner, v.flows);
  const keys = Object.keys(v) as (keyof SubMerchantInput)[];
  if (!keys.length) return sub;
  const identityChanged = IDENTITY.some((k) => k in v && (v[k] ?? null) !== (sub[k as keyof SubMerchantRow] ?? null));
  const backToReview = !staff && !partner.auto_approve && sub.status === "ACTIVE" && identityChanged;
  const sets = keys.map((k, i) => `${k} = $${i + 3}`);
  const r = await rows<SubMerchantRow>("vendorGateway", `
    UPDATE partner_sub_merchants SET ${sets.join(", ")}, updated_by = $2, updated_at = now()
      ${backToReview ? `, status = 'PENDING', status_reason = 'details changed: waiting for review', reviewed_by = NULL, reviewed_at = NULL` : ""}
     WHERE id = $1::uuid RETURNING ${SUB_COLS}
  `, [sub.id, by, ...keys.map((k) => v[k] ?? null)]);
  await logPartnerEvent(partner.id, "UPDATED", by, { fields: keys, back_to_review: backToReview }, sub.id);
  return r[0];
}

/** Approve, reject, suspend, reactivate or resubmit. The status change is logged by the database. */
export async function actOnSub(sub: SubMerchantRow, action: SubAction, reason: string | null, by: string): Promise<SubMerchantRow> {
  const m = moveSub(sub.status, action);
  if (!m.ok) throw new PartnerInputError({ field: "action", message: m.error }, 409, "INVALID_STATUS_CHANGE");
  const reviewed = action === "approve" || action === "reject";
  // Guarded on the status read, so two people acting at once cannot both move it.
  const r = await rows<SubMerchantRow>("vendorGateway", `
    UPDATE partner_sub_merchants SET status = $3, status_reason = $4, updated_by = $5, updated_at = now()
      ${reviewed ? ", reviewed_by = $5, reviewed_at = now()" : ""}
     WHERE id = $1::uuid AND status = $2 RETURNING ${SUB_COLS}
  `, [sub.id, sub.status, m.to, reason?.trim() || null, by]);
  if (!r.length) throw new PartnerInputError({ field: "action", message: "the sub-merchant changed meanwhile; reload and try again" }, 409, "INVALID_STATUS_CHANGE");
  return r[0];
}

/** The sub-merchant's live orders today (India day), failed and expired left out: what its day limit counts. */
export async function subTodayAmount(subId: string): Promise<number> {
  const r = await rows<{ a: string }>("vendorGateway", `
    SELECT COALESCE(SUM(amount), 0)::text AS a FROM vendor_payin_orders
     WHERE partner_sub_merchant_id = $1::uuid AND livemode AND status NOT IN ('FAILED','EXPIRED')
       AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
  `, [subId]);
  return Number(r[0]?.a ?? 0);
}

export interface SubTotals { sub_id: string; today_orders: number; today_paid: number; today_paid_amount: number; d30_paid_amount: number; d30_orders: number }

/** Per sub-merchant: today's orders and paid amount, and the last 30 days. */
export async function subTotals(partnerId: string, livemode: boolean): Promise<Record<string, SubTotals>> {
  const r = await rows<SubTotals>("vendorGateway", `
    SELECT partner_sub_merchant_id::text AS sub_id,
           COUNT(*) FILTER (WHERE created_at >= d0)::int AS today_orders,
           COUNT(*) FILTER (WHERE created_at >= d0 AND status = 'SUCCESS')::int AS today_paid,
           COALESCE(SUM(amount) FILTER (WHERE created_at >= d0 AND status = 'SUCCESS'), 0)::float AS today_paid_amount,
           COUNT(*)::int AS d30_orders,
           COALESCE(SUM(amount) FILTER (WHERE status = 'SUCCESS'), 0)::float AS d30_paid_amount
      FROM vendor_payin_orders,
           LATERAL (SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') AS d0) d
     WHERE partner_id = $1::uuid AND livemode = $2 AND created_at > now() - interval '30 days'
     GROUP BY 1
  `, [partnerId, livemode]);
  return Object.fromEntries(r.map((x) => [x.sub_id, x]));
}

export interface PartnerOrderRow {
  id: string; order_id: string; status: string; amount: number; created_at: string; updated_at: string;
  channel_type: string | null; merchant_id: string | null; livemode: boolean; rrn: string | null;
  sub_merchant_id: string | null;
}

export async function listPartnerOrders(partnerId: string, f: { subId?: string | null; livemode?: boolean | null; limit?: number } = {}): Promise<PartnerOrderRow[]> {
  return rows<PartnerOrderRow>("vendorGateway", `
    SELECT id::text, order_id, status, amount::float AS amount, created_at, updated_at, channel_type, merchant_id, livemode,
           rrn, partner_sub_merchant_id::text AS sub_merchant_id
      FROM vendor_payin_orders
     WHERE partner_id = $1::uuid AND ($2::uuid IS NULL OR partner_sub_merchant_id = $2::uuid)
       AND ($3::boolean IS NULL OR livemode = $3)
     ORDER BY created_at DESC LIMIT $4
  `, [partnerId, f.subId ?? null, f.livemode ?? null, Math.min(Math.max(f.limit ?? 100, 1), 500)]);
}

export interface PartnerEventRow { id: string; sub_merchant_id: string | null; action: string; from_status: string | null; to_status: string | null; detail: Record<string, unknown>; actor: string; at: string }

export async function listPartnerEvents(partnerId: string, subId: string | null = null, limit = 100): Promise<PartnerEventRow[]> {
  return rows<PartnerEventRow>("vendorGateway", `
    SELECT id::text, sub_merchant_id::text, action, from_status, to_status, detail, actor, at FROM partner_events
     WHERE partner_id = $1::uuid AND ($2::uuid IS NULL OR sub_merchant_id = $2::uuid)
     ORDER BY at DESC, id DESC LIMIT $3
  `, [partnerId, subId, limit]);
}
