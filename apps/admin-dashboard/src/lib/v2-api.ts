// The v2 order API:
//
//   POST /v2/orders                      create an order
//   GET  /v2/orders/{order_id|reference} read one, by Katana's id or the merchant's own reference
//
// It is a second door onto the same pay-in core as v1 (lib/katana-order): the flow rules, the
// limits, live activation, idempotency on the merchant's reference and the confirmation paths
// are the ones every order already goes through. What v2 changes is the contract around them:
//
//   auth      Authorization: Bearer <api key> (lib/v2-keys), over HTTPS. No request signature.
//   amounts   minor units (paise), an integer.
//   status    PENDING / SUCCESS / FAILED / EXPIRED and nothing else (lib/webhook-v2).
//   errors    every 4xx / 5xx is { code, message, reference }.
//   reading   GET answers with the same object a webhook carries.
//
// The gateway behind an order is never named (lib/merchant-safe): errors are scrubbed and
// `gateway` is always null.

import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { rows } from "@/lib/pg";
import { createKatanaOrder, MerchantBlockedError, PayinFlowError, PayinSetupError } from "@/lib/katana-order";
import { PayinLimitError } from "@/lib/payin-limits";
import { PayuIntentError, intentClientFrom } from "@/lib/payu-intent";
import { LiveModeNotActivatedError } from "@/lib/live-activation";
import { AccountNotLiveError } from "@/lib/gateway-golive";
import { merchantSafeError } from "@/lib/merchant-safe";
import { readOrderStatus } from "@/lib/pay-status";
import { publicBase } from "@/lib/payin-providers/types";
import { resolveV2Key, type V2KeyOwner } from "@/lib/v2-keys";
import { logApiRequest } from "@/lib/api-log";
import { clientIp } from "@/lib/session-security";
import { V2_ERRORS } from "@/lib/v2-api-errors";
import { orderUuidFrom, toMinorUnits, v2Body, v2ExpiresAt, v2OrderId, v2Status, type V2OrderRow } from "@/lib/webhook-v2";

// ── Errors ───────────────────────────────────────────────────────────────────────

export { V2_ERRORS };
export type V2ErrorCode = keyof typeof V2_ERRORS;

export class V2Error extends Error {
  constructor(readonly code: V2ErrorCode, message: string, readonly headers?: Record<string, string>) { super(message); }
  get status(): number { return V2_ERRORS[this.code].status; }
}

/** Any error from the pay-in core as a v2 error. Text that names a gateway is scrubbed. */
export function toV2Error(err: unknown, where: string): V2Error {
  if (err instanceof V2Error) return err;
  const safe = (m: string) => merchantSafeError(m, where);
  if (err instanceof PayinLimitError)
    return new V2Error(err.code, err.message, err.status === 429 ? { "retry-after": "1" } : undefined);
  if (err instanceof MerchantBlockedError)
    return new V2Error(err.code === "MERCHANT_SUSPENDED" ? "MERCHANT_SUSPENDED" : "MERCHANT_BLOCKED", "this account takes no orders");
  if (err instanceof LiveModeNotActivatedError) return new V2Error("LIVE_MODE_NOT_ACTIVATED", err.message);
  if (err instanceof AccountNotLiveError) return new V2Error("ACCOUNT_NOT_LIVE", err.message);
  if (err instanceof PayinFlowError) return new V2Error(err.code, safe(err.message));
  if (err instanceof PayinSetupError) return new V2Error("SETUP_INCOMPLETE", safe(err.message));
  if (err instanceof PayuIntentError) return new V2Error("PROCESSOR_ERROR", safe(err.message));
  // Anything else is ours. Its text (a database message, a stack) stays in the log.
  console.error(`[v2] ${where}:`, err);
  return new V2Error("INTERNAL_ERROR", "the request could not be completed; retry with the same reference");
}

// ── Request plumbing ─────────────────────────────────────────────────────────────

function requestRef(req: Request): string {
  const sent = req.headers.get("x-request-id")?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{8,64}$/.test(sent) ? sent : `req_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** HTTPS only. nginx sets X-Forwarded-Proto; outside production (no proxy) the check is skipped. */
function assertHttps(req: Request): void {
  if (process.env.NODE_ENV !== "production") return;
  const proto = (req.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim().toLowerCase();
  if (proto && proto !== "https") throw new V2Error("HTTPS_REQUIRED", "use https");
}

async function authenticate(req: Request): Promise<V2KeyOwner> {
  const h = req.headers.get("authorization") ?? "";
  const key = /^Bearer\s+(\S+)$/i.exec(h.trim())?.[1];
  if (!key) throw new V2Error("UNAUTHORIZED", "send your API key as: Authorization: Bearer <api key>");
  const owner = await resolveV2Key(key);
  if (!owner) throw new V2Error("UNAUTHORIZED", "the API key is not valid");
  return owner;
}

interface Handled { status: number; body: Record<string, unknown>; headers?: Record<string, string> }

/** Run a v2 handler: one error shape, one request reference, one log row. */
async function run(req: Request, endpoint: string, work: (owner: V2KeyOwner, body: unknown) => Promise<Handled>): Promise<NextResponse> {
  const started = Date.now();
  const reference = requestRef(req);
  let owner: V2KeyOwner | null = null, sent: unknown = null, out: Handled, code: string | null = null;
  try {
    assertHttps(req);
    owner = await authenticate(req);
    if (req.method !== "GET") {
      try { sent = await req.json(); } catch { throw new V2Error("INVALID_REQUEST", "the body must be JSON"); }
    }
    out = await work(owner, sent);
  } catch (err) {
    const e = toV2Error(err, endpoint);
    code = e.code;
    out = { status: e.status, body: { code: e.code, message: e.message, reference }, headers: e.headers };
  }
  logApiRequest({
    requestId: reference, merchantId: owner?.merchantCode ?? null, livemode: owner?.livemode ?? null,
    apiVersion: "v2", method: req.method, endpoint, httpStatus: out.status, latencyMs: Date.now() - started,
    errorCode: code, requestBody: sent, responseBody: out.body, ip: clientIp(req),
  });
  return NextResponse.json(out.body, { status: out.status, headers: { "x-request-id": reference, "cache-control": "no-store", ...out.headers } });
}

// ── Orders ───────────────────────────────────────────────────────────────────────

const httpUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), "must be an http(s) address");

const createSchema = z.object({
  amount: z.number({ invalid_type_error: "amount is an integer in minor units (paise)" }).int("amount is an integer in minor units (paise)").positive(),
  currency: z.string().default("INR"),
  // The merchant's own id for the order: unique per merchant, and what makes a retry safe.
  reference: z.string().min(1).max(60).refine((r) => !/^KTN_/i.test(r), "reference must not start with KTN_"),
  callback_url: httpUrl.optional(),
  return_url: httpUrl.optional(),
  flow: z.enum(["P2P", "INTENT"]).optional(),
  metadata: z.record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
    .refine((m) => Object.keys(m).length <= 20, "metadata holds at most 20 keys").optional(),
  customer: z.object({
    phone: z.string().max(20), vpa: z.string().max(120), ip: z.string().max(64), user_agent: z.string().max(512),
  }).partial().optional(),
});

const ORDER_COLS = `id::text, order_id, status, amount, currency_code, rrn, meta, created_at, updated_at, livemode`;

async function orderRow(id: string): Promise<(V2OrderRow & { livemode: boolean }) | null> {
  return (await rows<V2OrderRow & { livemode: boolean }>("vendorGateway",
    `SELECT ${ORDER_COLS} FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'KATANA'`, [id]))[0] ?? null;
}

const checkoutUrl = (id: string) => `${publicBase()}/pay/${id}`;

export function v2CreateOrder(req: Request): Promise<NextResponse> {
  return run(req, "/v2/orders", async (owner, sent) => {
    const p = createSchema.safeParse(sent);
    if (!p.success) {
      const i = p.error.issues[0];
      throw new V2Error("INVALID_REQUEST", `${i.path.join(".") || "body"}: ${i.message}`);
    }
    const b = p.data;
    if (b.currency.toUpperCase() !== "INR") throw new V2Error("UNSUPPORTED_CURRENCY", "currency must be INR");

    const r = await createKatanaOrder({
      orderId: b.reference, amount: b.amount / 100, currency: "INR",
      merchantId: owner.merchantCode, livemode: owner.livemode,   // the key decides the mode
      notifyUrl: b.callback_url ?? null, returnUrl: b.return_url ?? null,
      customerPhone: b.customer?.phone ?? null, customerVpa: b.customer?.vpa ?? null,
      client: intentClientFrom(req, { ip: b.customer?.ip, deviceInfo: b.customer?.user_agent }),
      flow: b.flow ?? null, metadata: b.metadata, apiVersion: "v2",
    });
    const o = r.order?.id ? await orderRow(r.order.id as string) : null;
    if (!o) throw new Error("order create returned no order");
    // The same reference again is the same order — unless it asks for a different amount, which
    // is a different order under a used reference and is refused rather than answered as paid-for.
    if (r.reused && toMinorUnits(o.amount) !== b.amount)
      throw new V2Error("REFERENCE_REUSED", `reference ${b.reference} already belongs to an order of a different amount`);
    return {
      status: r.reused ? 200 : 201,
      body: {
        order_id: v2OrderId(o.id), reference: o.order_id, status: v2Status(o.status),
        checkout_url: checkoutUrl(o.id), expires_at: v2ExpiresAt(o),
      },
    };
  });
}

/** The order a key may read by Katana's id or by its own reference: the key's banker and mode only. */
async function findOrderId(owner: V2KeyOwner, idOrReference: string): Promise<string | null> {
  const isKatanaId = /^KTN_/i.test(idOrReference);
  if (!isKatanaId) {
    const byRef = await rows<{ id: string }>("vendorGateway", `
      SELECT id::text FROM vendor_payin_orders
       WHERE vendor = 'KATANA' AND merchant_id = $1 AND livemode = $2 AND order_id = $3 LIMIT 1
    `, [owner.merchantCode, owner.livemode, idOrReference]);
    if (byRef.length) return byRef[0].id;
  }
  const uuid = orderUuidFrom(idOrReference);
  if (!uuid) return null;
  const byId = await rows<{ id: string }>("vendorGateway", `
    SELECT id::text FROM vendor_payin_orders
     WHERE vendor = 'KATANA' AND merchant_id = $1 AND livemode = $2 AND id = $3::uuid LIMIT 1
  `, [owner.merchantCode, owner.livemode, uuid]);
  return byId[0]?.id ?? null;
}

export function v2GetOrder(req: Request, idOrReference: string): Promise<NextResponse> {
  return run(req, "/v2/orders/{id}", async (owner) => {
    const id = await findOrderId(owner, idOrReference);
    if (!id) throw new V2Error("ORDER_NOT_FOUND", "no order with that id or reference");
    // The same read the pay page makes: it asks the processor about an open order and applies
    // the expiry, so this answer is the current one, not the last one stored.
    await readOrderStatus(id);
    const o = await orderRow(id);
    if (!o) throw new V2Error("ORDER_NOT_FOUND", "no order with that id or reference");
    const cb = o.meta?.callback;
    const body = v2Body(o, typeof cb?.event_id === "string" && v2Body(o).status !== "PENDING" ? cb.event_id : null);
    return {
      status: 200,
      body: {
        ...body,
        checkout_url: body.status === "PENDING" ? checkoutUrl(o.id) : null,
        expires_at: v2ExpiresAt(o),
        created_at: o.created_at ? new Date(o.created_at).toISOString() : null,
        livemode: o.livemode !== false,
        metadata: o.meta?.metadata ?? null,
      },
    };
  });
}
