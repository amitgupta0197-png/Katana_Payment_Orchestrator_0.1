// The partner API (lib/partner): a payment aggregator onboards its merchants and takes their
// payments through Katana.
//
//   POST  /api/v1/partner/merchants           onboard a sub-merchant
//   GET   /api/v1/partner/merchants           list them (?status=&q=&limit=)
//   GET   /api/v1/partner/merchants/{id}      one, by Katana's id (SM_…) or the partner's external_id
//   PATCH /api/v1/partner/merchants/{id}      change its details, flows or limits
//   POST  /api/v1/partner/orders              create an order for a sub-merchant
//   GET   /api/v1/partner/orders/{id|ref}     read one, by Katana's id or the partner's reference
//
// The contract is the v2 one (lib/v2-api): Authorization: Bearer pk_live_… / pk_test_… (the key
// decides the mode), HTTPS, amounts in paise, PENDING / SUCCESS / FAILED / EXPIRED, every error
// { code, message, reference }. The gateway behind an order is never named (lib/merchant-safe):
// a partner is a merchant.

import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows } from "@/lib/pg";
import { intentClientFrom } from "@/lib/payu-intent";
import { readOrderStatus } from "@/lib/pay-status";
import { publicBase } from "@/lib/payin-providers/types";
import { logApiRequest } from "@/lib/api-log";
import { clientIp } from "@/lib/session-security";
import { toV2Error } from "@/lib/v2-api";
import { orderUuidFrom, toMinorUnits, v2ExpiresAt, v2OrderId, type V2OrderRow } from "@/lib/webhook-v2";
import { PARTNER_API_ERRORS, type PartnerApiErrorCode } from "@/lib/partner/api-errors";
import { resolvePartnerKey, type PartnerKeyOwner } from "@/lib/partner/keys";
import { SUB_FLOWS, SUB_STATUSES, partnerSigner, type SubMerchantInput, type SubStatus } from "@/lib/partner/rules";
import { createSub, getSub, listSubs, PartnerInputError, updateSub, type SubMerchantRow } from "@/lib/partner/store";
import { createPartnerOrder, PartnerReferenceError, PartnerRefusalError } from "@/lib/partner/orders";
import { partnerOrderBody } from "@/lib/partner/callback";

export class PartnerApiError extends Error {
  constructor(readonly code: PartnerApiErrorCode, message: string, readonly extra?: Record<string, unknown>, readonly headers?: Record<string, string>) { super(message); }
  get status(): number { return PARTNER_API_ERRORS[this.code].status; }
}

function toPartnerError(err: unknown, where: string): PartnerApiError {
  if (err instanceof PartnerApiError) return err;
  if (err instanceof PartnerRefusalError) {
    const { code, message, limit, actual } = err.refusal;
    return new PartnerApiError(code, message, limit != null ? { limit: toMinorUnits(limit), actual: toMinorUnits(actual ?? 0) } : undefined);
  }
  if (err instanceof PartnerReferenceError) return new PartnerApiError("REFERENCE_REUSED", err.message);
  if (err instanceof PartnerInputError) {
    const code = (err.code in PARTNER_API_ERRORS ? err.code : "INVALID_REQUEST") as PartnerApiErrorCode;
    return new PartnerApiError(code, err.message, { field: err.problem.field });
  }
  // The pay-in core's refusals, as v2 states them (gateway names scrubbed there).
  const v = toV2Error(err, where);
  return new PartnerApiError(v.code as PartnerApiErrorCode, v.message, undefined, v.headers);
}

function requestRef(req: Request): string {
  const sent = req.headers.get("x-request-id")?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{8,64}$/.test(sent) ? sent : `req_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** HTTPS only. nginx sets X-Forwarded-Proto; outside production (no proxy) the check is skipped. */
function assertHttps(req: Request): void {
  if (process.env.NODE_ENV !== "production") return;
  const proto = (req.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim().toLowerCase();
  if (proto && proto !== "https") throw new PartnerApiError("HTTPS_REQUIRED", "use https");
}

async function authenticate(req: Request): Promise<PartnerKeyOwner> {
  const key = /^Bearer\s+(\S+)$/i.exec((req.headers.get("authorization") ?? "").trim())?.[1];
  if (!key) throw new PartnerApiError("UNAUTHORIZED", "send your partner API key as: Authorization: Bearer <pk_live_… or pk_test_…>");
  const owner = await resolvePartnerKey(key);
  if (!owner) throw new PartnerApiError("UNAUTHORIZED", "the partner API key is not valid");
  return owner;
}

interface Handled { status: number; body: Record<string, unknown>; headers?: Record<string, string>; banker?: string | null }

/** Run a partner handler: one error shape, one request reference, one log row. */
async function run(req: Request, endpoint: string, work: (owner: PartnerKeyOwner, body: unknown, reference: string) => Promise<Handled>): Promise<NextResponse> {
  const started = Date.now();
  const reference = requestRef(req);
  let owner: PartnerKeyOwner | null = null, sent: unknown = null, out: Handled, code: string | null = null;
  try {
    assertHttps(req);
    owner = await authenticate(req);
    if (req.method !== "GET") {
      try { sent = await req.json(); } catch { throw new PartnerApiError("INVALID_REQUEST", "the body must be JSON"); }
    }
    out = await work(owner, sent, reference);
  } catch (err) {
    const e = toPartnerError(err, endpoint);
    code = e.code;
    out = { status: e.status, body: { code: e.code, message: e.message, reference, ...e.extra }, headers: e.headers };
  }
  logApiRequest({
    requestId: reference, merchantId: out.banker ?? (owner ? partnerSigner(owner.partner.id) : null), livemode: owner?.livemode ?? null,
    apiVersion: "partner", method: req.method, endpoint, httpStatus: out.status, latencyMs: Date.now() - started,
    errorCode: code, requestBody: sent, responseBody: out.body, ip: clientIp(req),
  });
  return NextResponse.json(out.body, { status: out.status, headers: { "x-request-id": reference, "cache-control": "no-store", ...out.headers } });
}

const invalid = (p: z.ZodError): PartnerApiError => {
  const i = p.issues[0];
  return new PartnerApiError("INVALID_REQUEST", `${i.path.join(".") || "body"}: ${i.message}`, { field: i.path.join(".") || null });
};

// ── Sub-merchants ────────────────────────────────────────────────────────────────

const paise = z.number({ invalid_type_error: "an integer amount in paise" }).int("an integer amount in paise").positive().nullable();
const subSchema = z.object({
  external_id: z.string(),
  legal_name: z.string(),
  display_name: z.string().nullable(),
  business_type: z.string().nullable(),
  category: z.string().nullable(),
  pan: z.string().nullable(),
  gstin: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  address: z.string().nullable(),
  flows: z.enum(SUB_FLOWS),
  limits: z.object({ min_amount: paise, max_amount: paise, daily_amount: paise }).partial(),
}).partial().strict();

/** The API's body (limits in paise) as the store's input (rupees). */
function subInput(b: z.infer<typeof subSchema>): Partial<SubMerchantInput> {
  const { limits, ...rest } = b;
  const out: Partial<SubMerchantInput> = { ...rest };
  if (limits) for (const k of ["min_amount", "max_amount", "daily_amount"] as const)
    if (k in limits) out[k] = limits[k] == null ? null : limits[k]! / 100;
  return out;
}

const paiseOrNull = (v: number | null) => (v == null ? null : toMinorUnits(v));

/** A sub-merchant as the partner reads it. */
export function subView(s: SubMerchantRow) {
  return {
    id: s.sub_code, external_id: s.external_id, legal_name: s.legal_name, display_name: s.display_name,
    business_type: s.business_type, category: s.category, pan: s.pan, gstin: s.gstin, email: s.email, phone: s.phone,
    website: s.website, address: s.address, flows: s.flows,
    limits: { min_amount: paiseOrNull(s.min_amount), max_amount: paiseOrNull(s.max_amount), daily_amount: paiseOrNull(s.daily_amount) },
    status: s.status, status_reason: s.status_reason,
    created_at: new Date(s.created_at).toISOString(), updated_at: new Date(s.updated_at).toISOString(),
  };
}

async function subOrThrow(partnerId: string, ref: string): Promise<SubMerchantRow> {
  const s = await getSub(partnerId, ref);
  if (!s) throw new PartnerApiError("SUB_MERCHANT_NOT_FOUND", "no sub-merchant with that id or external_id");
  return s;
}

export function partnerCreateSub(req: Request): Promise<NextResponse> {
  return run(req, "/api/v1/partner/merchants", async (owner, sent) => {
    const p = subSchema.safeParse(sent);
    if (!p.success) throw invalid(p.error);
    const s = await createSub(owner.partner, subInput(p.data), "API", `partner:${owner.partner.code}`);
    return { status: 201, body: subView(s) };
  });
}

export function partnerListSubs(req: Request): Promise<NextResponse> {
  return run(req, "/api/v1/partner/merchants", async (owner) => {
    const u = new URL(req.url);
    const status = u.searchParams.get("status")?.toUpperCase() ?? null;
    if (status && !SUB_STATUSES.includes(status as SubStatus)) throw new PartnerApiError("INVALID_REQUEST", `status is one of ${SUB_STATUSES.join(", ")}`);
    const list = await listSubs(owner.partner.id, { status: status as SubStatus | null, q: u.searchParams.get("q"), limit: Number(u.searchParams.get("limit") ?? 100) || 100 });
    return { status: 200, body: { data: list.map(subView) } };
  });
}

export function partnerGetSub(req: Request, id: string): Promise<NextResponse> {
  return run(req, "/api/v1/partner/merchants/{id}", async (owner) => ({ status: 200, body: subView(await subOrThrow(owner.partner.id, id)) }));
}

export function partnerUpdateSub(req: Request, id: string): Promise<NextResponse> {
  return run(req, "/api/v1/partner/merchants/{id}", async (owner, sent) => {
    const p = subSchema.omit({ external_id: true }).strict().safeParse(sent);
    if (!p.success) throw invalid(p.error);
    const s = await subOrThrow(owner.partner.id, id);
    const updated = await updateSub(owner.partner, s, subInput(p.data), `partner:${owner.partner.code}`, false);
    return { status: 200, body: subView(updated) };
  });
}

// ── Orders ───────────────────────────────────────────────────────────────────────

const httpUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), "must be an http(s) address");

const orderSchema = z.object({
  sub_merchant_id: z.string().min(1).max(60),
  amount: z.number({ invalid_type_error: "amount is an integer in minor units (paise)" }).int("amount is an integer in minor units (paise)").positive(),
  currency: z.string().default("INR"),
  reference: z.string().min(1).max(60).refine((r) => !/^KTN_/i.test(r), "reference must not start with KTN_"),
  flow: z.enum(["P2P", "INTENT"]).optional(),
  callback_url: httpUrl.optional(),
  return_url: httpUrl.optional(),
  metadata: z.record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
    .refine((m) => Object.keys(m).length <= 20, "metadata holds at most 20 keys").optional(),
  customer: z.object({
    phone: z.string().max(20), vpa: z.string().max(120), ip: z.string().max(64), user_agent: z.string().max(512),
  }).partial().optional(),
});

const ORDER_COLS = `id::text, order_id, status, amount, currency_code, rrn, meta, created_at, updated_at, livemode, merchant_id`;
type PartnerOrderRow = V2OrderRow & { livemode: boolean; merchant_id: string | null };

async function orderRow(id: string): Promise<PartnerOrderRow | null> {
  return (await rows<PartnerOrderRow>("vendorGateway", `SELECT ${ORDER_COLS} FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'KATANA'`, [id]))[0] ?? null;
}

const checkoutUrl = (id: string) => `${publicBase()}/pay/${id}`;

export function partnerCreateOrder(req: Request): Promise<NextResponse> {
  return run(req, "/api/v1/partner/orders", async (owner, sent, reference) => {
    const p = orderSchema.safeParse(sent);
    if (!p.success) throw invalid(p.error);
    const b = p.data;
    if (b.currency.toUpperCase() !== "INR") throw new PartnerApiError("UNSUPPORTED_CURRENCY", "currency must be INR");
    const sub = await subOrThrow(owner.partner.id, b.sub_merchant_id);
    const r = await createPartnerOrder({
      partner: owner.partner, sub, livemode: owner.livemode, reference: b.reference, amount: b.amount / 100,
      flow: b.flow ?? null, callbackUrl: b.callback_url ?? null, returnUrl: b.return_url ?? null,
      customerPhone: b.customer?.phone ?? null, customerVpa: b.customer?.vpa ?? null,
      client: intentClientFrom(req, { ip: b.customer?.ip, deviceInfo: b.customer?.user_agent }),
      metadata: b.metadata, requestId: reference,
    });
    const o = r.order?.id ? await orderRow(r.order.id as string) : null;
    if (!o) throw new Error("order create returned no order");
    const body = partnerOrderBody(o);
    return {
      status: r.reused ? 200 : 201, banker: o.merchant_id,
      body: {
        order_id: v2OrderId(o.id), reference: o.order_id, sub_merchant_id: body.sub_merchant_id, external_id: body.external_id,
        status: body.status, amount: body.amount, currency: body.currency, flow: r.order.channel_type ?? null,
        checkout_url: body.status === "PENDING" ? checkoutUrl(o.id) : null, expires_at: v2ExpiresAt(o), livemode: owner.livemode,
      },
    };
  });
}

/** The order a partner key may read: the partner's own, in the key's mode, by Katana's id or the partner's reference. */
async function findOrderId(owner: PartnerKeyOwner, idOrReference: string): Promise<string | null> {
  if (!/^KTN_/i.test(idOrReference)) {
    const byRef = await rows<{ id: string }>("vendorGateway", `
      SELECT id::text FROM vendor_payin_orders
       WHERE vendor = 'KATANA' AND partner_id = $1::uuid AND livemode = $2 AND order_id = $3 LIMIT 1
    `, [owner.partner.id, owner.livemode, idOrReference]);
    if (byRef.length) return byRef[0].id;
  }
  const uuid = orderUuidFrom(idOrReference);
  if (!uuid) return null;
  const byId = await rows<{ id: string }>("vendorGateway", `
    SELECT id::text FROM vendor_payin_orders WHERE vendor = 'KATANA' AND partner_id = $1::uuid AND livemode = $2 AND id = $3::uuid LIMIT 1
  `, [owner.partner.id, owner.livemode, uuid]);
  return byId[0]?.id ?? null;
}

export function partnerGetOrder(req: Request, idOrReference: string): Promise<NextResponse> {
  return run(req, "/api/v1/partner/orders/{id}", async (owner) => {
    const id = await findOrderId(owner, idOrReference);
    if (!id) throw new PartnerApiError("ORDER_NOT_FOUND", "no order with that id or reference");
    // The read the pay page makes: asks the processor about an open order and applies the expiry.
    await readOrderStatus(id);
    const o = await orderRow(id);
    if (!o) throw new PartnerApiError("ORDER_NOT_FOUND", "no order with that id or reference");
    const cb = o.meta?.callback;
    const pending = partnerOrderBody(o).status === "PENDING";
    const body = partnerOrderBody(o, typeof cb?.event_id === "string" && !pending ? cb.event_id : null);
    return {
      status: 200, banker: o.merchant_id,
      body: {
        ...body,
        checkout_url: pending ? checkoutUrl(o.id) : null,
        expires_at: v2ExpiresAt(o),
        created_at: o.created_at ? new Date(o.created_at).toISOString() : null,
        metadata: o.meta?.metadata ?? null,
      },
    };
  });
}

