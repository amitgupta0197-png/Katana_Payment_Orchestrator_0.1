// The order desk: find any pay-in by one piece of text, and see everything that happened to it.
//
//   search     Katana's order id, the merchant's own reference, or the bank reference (RRN)
//   timeline   the order as created, each status change, and each webhook delivery attempt
//
// One reader for the merchant portal, the banker portal and staff. What differs is what is
// shown: a merchant sees a plain label for each status change, staff also see who or what made
// it and on what evidence (which can name a gateway, so it stays with staff — lib/merchant-safe).
// Statuses are the four v2 words throughout (lib/webhook-v2).

import { rows } from "@/lib/pg";
import { callbackStatus } from "@/lib/katana-pay";
import { orderUuidFrom, v2Body, v2ExpiresAt, v2EventFor, v2OrderId, v2Status, type V2Status } from "@/lib/webhook-v2";
import type { PortalScope } from "@/lib/portal-scope";

export interface OrderHit {
  id: string; order_id: string; reference: string; status: V2Status; amount: number;
  merchant_id: string | null; flow: string | null; livemode: boolean; created_at: string; rrn: string | null;
}

const HIT_COLS = `id::text, order_id, status, amount, merchant_id, channel_type, livemode, created_at, rrn`;

function hit(r: any): OrderHit {
  const status = v2Status(r.status);
  return {
    id: r.id, order_id: v2OrderId(r.id), reference: r.order_id, status, amount: Number(r.amount),
    merchant_id: r.merchant_id, flow: r.channel_type ?? null, livemode: r.livemode !== false,
    created_at: new Date(r.created_at).toISOString(), rrn: status === "SUCCESS" ? r.rrn || null : null,
  };
}

/**
 * Orders matching `q`: exactly by Katana id or bank reference, and by the merchant's reference
 * exactly or as a prefix. Scoped to the bankers the session may see.
 */
export async function searchOrders(q: string, scope: PortalScope): Promise<OrderHit[]> {
  const text = q.trim();
  if (text.length < 3 || (scope.codes && !scope.codes.length)) return [];
  const uuid = orderUuidFrom(text);
  const like = text.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
  const r = await rows<any>("vendorGateway", `
    SELECT ${HIT_COLS} FROM vendor_payin_orders o
     WHERE vendor = 'KATANA'
       AND ($1::text[] IS NULL OR merchant_id = ANY($1::text[]))
       AND (($2::uuid IS NOT NULL AND o.id = $2::uuid) OR order_id = $3 OR rrn = $3 OR order_id LIKE $4)
     ORDER BY (o.id = $2::uuid OR order_id = $3 OR rrn = $3) DESC, o.created_at DESC
     LIMIT 25
  `, [scope.codes, uuid, text, like]);
  return r.map(hit);
}

/** The newest orders of the bankers in scope, for the order list before anything is searched. */
export async function recentOrders(scope: PortalScope, limit = 25): Promise<OrderHit[]> {
  if (scope.codes && !scope.codes.length) return [];
  const r = await rows<any>("vendorGateway", `
    SELECT ${HIT_COLS} FROM vendor_payin_orders o
     WHERE vendor = 'KATANA' AND ($1::text[] IS NULL OR merchant_id = ANY($1::text[]))
     ORDER BY o.created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}
  `, [scope.codes]);
  return r.map(hit);
}

export interface TimelineStep {
  at: string;
  from: V2Status | null;
  to: V2Status;
  /** What a merchant is told happened. */
  label: string;
  /** Staff only: who or what made the change, and the evidence it was made on. */
  actor?: string | null;
  evidence?: string | null;
  request_id?: string | null;
}

export interface DeliveryAttempt { attempt_no: number; sent_at: string; http_status: number | null; latency_ms: number | null; error: string | null; response_body?: string | null }

export interface Delivery {
  outbox_id: string;
  /** payment.success / payment.failed / payment.expired, whichever contract it was sent in. */
  event: string;
  version: "v1" | "v2";
  event_id: string | null;
  status: string;            // DELIVERED | PENDING | DEAD_LETTER
  target_url: string;
  created_at: string;
  next_attempt_at: string | null;
  resend_of: string | null;
  requested_by: string | null;
  attempts: DeliveryAttempt[];
}

export interface OrderTimeline {
  order: OrderHit & { expires_at: string | null; paid_at: string | null; rrn_is_synthetic: boolean; previous_status: string | null; callback_url: string | null; api_version: string };
  steps: TimelineStep[];
  deliveries: Delivery[];
}

/** The plain words for one status change. Pure. */
export function stepLabel(from: V2Status | null, to: V2Status): string {
  if (from === null) return to === "PENDING" ? "Order created" : `Order recorded as ${to}`;
  if (to === "SUCCESS") return from === "EXPIRED" ? "Payment confirmed after the order had expired"
    : from === "FAILED" ? "Payment confirmed after an earlier attempt failed" : "Payment confirmed";
  if (to === "FAILED") return "Payment failed";
  if (to === "EXPIRED") return "Order expired: no payment arrived in time";
  return `Status changed to ${to}`;
}

/** The v2 name of the event a callback row announced, whichever contract it was sent in. */
function eventOf(eventType: string, payload: Record<string, any> | null): string {
  if (eventType.startsWith("payment.")) return eventType;
  const word = String(payload?.STATUS ?? "");
  for (const s of ["SUCCESS", "FAILED", "EXPIRED"] as V2Status[])
    if (callbackStatus(s).STATUS === word) return v2EventFor(s)!;
  return eventType;
}

/** Callback rows with their attempts, newest first. `where` is a condition on webhook_outbox. */
export async function readDeliveries(where: string, args: unknown[], staff: boolean, limit = 50): Promise<Delivery[]> {
  const out = await rows<any>("notification", `
    SELECT outbox_id::text, event_type, payload, target_url, status, created_at, next_attempt_at,
           version, event_id, resend_of::text, requested_by
      FROM webhook_outbox WHERE ${where} ORDER BY created_at DESC LIMIT ${limit}
  `, args);
  if (!out.length) return [];
  const att = await rows<any>("notification", `
    SELECT outbox_id::text, attempt_no, attempted_at, response_status, duration_ms, error, response_body
      FROM webhook_dispatch_attempts WHERE outbox_id = ANY($1::uuid[]) ORDER BY attempt_no
  `, [out.map((o) => o.outbox_id)]);
  return out.map((o) => ({
    outbox_id: o.outbox_id, event: eventOf(o.event_type, o.payload), version: o.version === "v2" ? "v2" : "v1",
    event_id: o.event_id ?? null, status: o.status, target_url: o.target_url,
    created_at: new Date(o.created_at).toISOString(),
    next_attempt_at: o.status === "PENDING" && o.next_attempt_at ? new Date(o.next_attempt_at).toISOString() : null,
    resend_of: o.resend_of ?? null, requested_by: staff ? o.requested_by ?? null : null,
    attempts: att.filter((a) => a.outbox_id === o.outbox_id).map((a) => ({
      attempt_no: a.attempt_no, sent_at: new Date(a.attempted_at).toISOString(),
      http_status: a.response_status ?? null, latency_ms: a.duration_ms ?? null, error: a.error ?? null,
      // What the merchant's own server answered is the merchant's to see; kept to staff anyway,
      // because a misconfigured callback URL can point at somebody else's server.
      ...(staff ? { response_body: a.response_body ?? null } : {}),
    })),
  }));
}

/** Everything about one order, or null when it is not one the session may see. */
export async function orderTimeline(idOrKtn: string, scope: PortalScope): Promise<OrderTimeline | null> {
  const uuid = orderUuidFrom(idOrKtn);
  if (!uuid || (scope.codes && !scope.codes.length)) return null;
  const o = (await rows<any>("vendorGateway", `
    SELECT ${HIT_COLS}, currency_code, meta, updated_at FROM vendor_payin_orders
     WHERE vendor = 'KATANA' AND id = $1::uuid AND ($2::text[] IS NULL OR merchant_id = ANY($2::text[]))
  `, [uuid, scope.codes]))[0];
  if (!o) return null;

  const [history, deliveries] = await Promise.all([
    rows<any>("vendorGateway", `
      SELECT from_status, to_status, actor, evidence, request_id, changed_at
        FROM vendor_payin_status_history h WHERE order_id = $1::uuid ORDER BY h.changed_at, h.id
    `, [uuid]).catch(() => []),
    readDeliveries("order_id = $1::uuid", [uuid], scope.staff).catch(() => []),
  ]);

  const body = v2Body(o);
  const meta = o.meta ?? {};
  return {
    order: {
      ...hit(o), expires_at: v2ExpiresAt(o), paid_at: body.paid_at, rrn_is_synthetic: body.rrn_is_synthetic,
      previous_status: body.previous_status ?? null,
      callback_url: typeof meta.notify_url === "string" ? meta.notify_url : null,
      api_version: meta.api_version === "v2" ? "v2" : "v1",
    },
    steps: history.map((h) => {
      const from = h.from_status == null ? null : v2Status(h.from_status), to = v2Status(h.to_status);
      return {
        at: new Date(h.changed_at).toISOString(), from, to, label: stepLabel(from, to),
        ...(scope.staff ? { actor: h.actor ?? null, evidence: h.evidence ?? null, request_id: h.request_id ?? null } : {}),
      };
    // A change between two stored statuses that are the same v2 word is not a change a reader needs.
    }).filter((s) => s.from !== s.to),
    deliveries,
  };
}
