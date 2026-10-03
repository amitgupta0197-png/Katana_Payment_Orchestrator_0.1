// The v2 contract: what an order looks like to a merchant, and how a webhook is signed.
//
// PURE apart from `crypto`: no database, no network. The v2 order API (lib/v2-api), the callback
// sender (lib/merchant-callback), the outbox (lib/webhook-outbox) and the portal all build the
// same object from here, so the status API and the webhook can never describe an order
// differently.
//
// ONE VOCABULARY. A v2 status is one of four words and nothing else:
//
//   PENDING   created, waiting for the payment
//   SUCCESS   the payment is confirmed
//   FAILED    declined, or an error that cannot be recovered
//   EXPIRED   the customer's time ran out. A payment that lands afterwards still makes it SUCCESS.
//
// The stored statuses, the v1 words (Captured …) and the response codes stay on the v1 side.
// The gateway behind an order is never named: `gateway` is always null (lib/merchant-safe).

import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { genRrn, orderExpirySeconds, autoResolvePaused } from "@/lib/katana-pay";

export const V2_STATUSES = ["PENDING", "SUCCESS", "FAILED", "EXPIRED"] as const;
export type V2Status = (typeof V2_STATUSES)[number];

/** A stored order status in the v2 vocabulary. Anything not final is PENDING. */
export function v2Status(stored: string | null | undefined): V2Status {
  const s = (stored ?? "").toUpperCase();
  if (s === "SUCCESS" || s === "SUCCEEDED") return "SUCCESS";
  if (s === "FAILED") return "FAILED";
  if (s === "EXPIRED") return "EXPIRED";
  return "PENDING";
}

export type V2Event = "payment.success" | "payment.failed" | "payment.expired";
export const V2_EVENTS: V2Event[] = ["payment.success", "payment.failed", "payment.expired"];

/** The event a final status is announced with; null while the order is PENDING. */
export function v2EventFor(status: V2Status): V2Event | null {
  return status === "SUCCESS" ? "payment.success" : status === "FAILED" ? "payment.failed" : status === "EXPIRED" ? "payment.expired" : null;
}

export function v2StatusOfEvent(event: V2Event): V2Status {
  return event === "payment.success" ? "SUCCESS" : event === "payment.failed" ? "FAILED" : "EXPIRED";
}

// ── Ids ──────────────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The order id a merchant is given: KTN_ and the order's own id without its dashes. */
export function v2OrderId(uuid: string): string {
  return `KTN_${uuid.replace(/-/g, "").toLowerCase()}`;
}

/** The stored id behind a KTN_ order id (or a bare uuid), or null when it is neither. */
export function orderUuidFrom(value: string): string | null {
  const v = value.trim();
  if (UUID.test(v)) return v.toLowerCase();
  const m = /^KTN_([0-9a-f]{32})$/i.exec(v);
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function newEventId(): string {
  return `evt_${randomUUID().replace(/-/g, "")}`;
}

// ── The order, as v2 states it ───────────────────────────────────────────────────

/** The columns of vendor_payin_orders the v2 body is built from. */
export interface V2OrderRow {
  id: string;
  order_id: string;                 // the merchant's reference
  status: string;
  amount: number | string;          // rupees, as stored
  currency_code: string | null;
  rrn: string | null;
  meta: Record<string, any> | null;
  updated_at?: string | Date | null;
  created_at?: string | Date | null;
  livemode?: boolean | null;
}

export interface V2Body {
  event: V2Event | null;
  event_id: string | null;
  order_id: string;
  reference: string;
  status: V2Status;
  previous_status?: "EXPIRED" | "FAILED";
  amount: number;                   // minor units
  currency: string;
  rrn: string | null;
  rrn_is_synthetic: boolean;
  paid_at: string | null;
  gateway: null;
}

const iso = (v: string | Date | null | undefined): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Rupees as stored (numeric, two places) in minor units. */
export function toMinorUnits(amount: number | string): number {
  return Math.round(Number(amount) * 100);
}

/**
 * True when the order's bank reference was made by Katana rather than read from a bank or a
 * gateway. An order confirmed with no reference (a payment notice that stated none, a forced
 * test outcome) is given one derived from its id, so its status answers stay stable; that value
 * appears on no bank statement, and v2 says so.
 */
export function rrnIsSynthetic(orderId: string, rrn: string | null | undefined): boolean {
  return !!rrn && rrn === genRrn(orderId);
}

/**
 * The v2 account of an order. The webhook body and GET /v2/orders/{id} are both this object.
 * `eventId` is the id of the event being delivered; the status API passes the id of the last
 * event sent for the order's current status, or null.
 */
export function v2Body(o: V2OrderRow, eventId: string | null = null): V2Body {
  const status = v2Status(o.status);
  const meta = o.meta ?? {};
  const paid = status === "SUCCESS";
  const previous: "EXPIRED" | "FAILED" | null = !paid ? null
    : meta.revived_from_expired ? "EXPIRED" : meta.revived_from_failed ? "FAILED" : null;
  const rrn = paid && o.rrn ? o.rrn : null;
  return {
    event: v2EventFor(status),
    event_id: eventId,
    order_id: v2OrderId(o.id),
    reference: o.order_id,
    status,
    ...(previous ? { previous_status: previous } : {}),
    amount: toMinorUnits(o.amount),
    currency: (o.currency_code ?? "INR").toUpperCase(),
    rrn,
    rrn_is_synthetic: rrnIsSynthetic(o.id, rrn),
    paid_at: paid ? iso(typeof meta.confirmation?.at === "string" ? meta.confirmation.at : o.updated_at) : null,
    gateway: null,
  };
}

/**
 * When a PENDING order stops waiting and is told EXPIRED; null once it is final, and for an order
 * held for a manual check. For an order sent to a gateway this is after the customer's time to
 * pay: it includes the confirmation window (lib/katana-pay), when there is one.
 */
export function v2ExpiresAt(o: V2OrderRow, env: Record<string, string | undefined> = process.env): string | null {
  if (v2Status(o.status) !== "PENDING" || autoResolvePaused(o.meta)) return null;
  const created = iso(o.created_at);
  const after = orderExpirySeconds(o.meta, o.livemode !== false, env);
  return created ? new Date(new Date(created).getTime() + after * 1000).toISOString() : null;
}

/** A sample body for a test event: no order behind it, and marked so in its ids. */
export function v2SampleBody(event: V2Event, eventId: string): V2Body {
  const status = v2StatusOfEvent(event);
  const paid = status === "SUCCESS";
  return {
    event, event_id: eventId,
    order_id: "KTN_test00000000000000000000000000",
    reference: "test-event",
    status,
    amount: 10000, currency: "INR",
    rrn: paid ? "000000000000" : null,
    rrn_is_synthetic: paid,
    paid_at: paid ? new Date().toISOString() : null,
    gateway: null,
  };
}

// ── Signing ──────────────────────────────────────────────────────────────────────
//
//   X-Katana-Signature: t=<unix seconds>,v1=<hex>
//   v1 = HMAC-SHA256(key = webhook secret, message = "<t>.<raw request body>")
//
// The timestamp is inside what is signed, so a captured delivery cannot be replayed later with
// a fresh one. A receiver refuses a delivery whose timestamp is more than 300 seconds from now.

export const V2_SIGNATURE_TOLERANCE_SECONDS = 300;

export function v2Signature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function v2SignatureHeader(secret: string, timestamp: number, rawBody: string): string {
  return `t=${timestamp},v1=${v2Signature(secret, timestamp, rawBody)}`;
}

/** What a receiver does with the header. Here for the tests and the guide's reference code. */
export function verifyV2Signature(header: string | null | undefined, rawBody: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries((header ?? "").split(",").map((p) => p.trim().split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(nowSeconds - t) > V2_SIGNATURE_TOLERANCE_SECONDS) return false;
  const a = Buffer.from(v2Signature(secret, t, rawBody), "utf8"), b = Buffer.from(parts.v1, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newWebhookSecret(): string {
  return `whsec_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

// ── Which events a merchant is sent ──────────────────────────────────────────────

export const WEBHOOK_VERSIONS = ["v1", "v2"] as const;
export type WebhookVersion = (typeof WEBHOOK_VERSIONS)[number];
export const WEBHOOK_EVENT_PREFS = ["ALL", "PAID_ONLY"] as const;
/** ALL: success, failed and expired. PAID_ONLY: success only; the rest is read from the status API. */
export type WebhookEventPref = (typeof WEBHOOK_EVENT_PREFS)[number];

export function wantsEvent(pref: WebhookEventPref, status: V2Status): boolean {
  return pref === "ALL" || status === "SUCCESS";
}
