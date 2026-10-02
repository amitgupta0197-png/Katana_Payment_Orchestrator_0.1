// A record that a pay-in gateway's webhook arrived (vendorGateway 0038), and what came of it.
//
// The order records what a webhook changed; nothing recorded that one came. This is what lets
// the gateway health screen say when a gateway last called, and the go-live checklist say that
// a payment was reported by the gateway itself. STAFF ONLY: it names gateways.
//
// Best-effort and not awaited: a webhook is answered whether or not this row is written.

import { rows } from "@/lib/pg";

export type GatewayWebhookOutcome =
  | "APPLIED" | "ALREADY_FINAL" | "NOT_FINAL" | "NOT_APPLIED" | "UNKNOWN_ORDER"
  | "BAD_SIGNATURE" | "NOT_CONNECTED" | "LOOKUP_FAILED" | "IGNORED";

export interface GatewayWebhookEvent {
  gateway: string;
  merchantId?: string | null;
  /** Katana's reference at the gateway (vendor_txn_id / checkout txn_id). */
  txnId?: string | null;
  /** true / false, or null when the gateway does not sign its events. */
  signatureOk?: boolean | null;
  outcome: GatewayWebhookOutcome;
  /** SUCCESS / FAILED / UNKNOWN, as Katana read the gateway's answer. */
  status?: string | null;
}

/** What a gateway check answered (lib/gateway-payin's ApplyResult), as an outcome. Pure. */
export function outcomeOf(r: { applied: boolean; reason?: string }): GatewayWebhookOutcome {
  if (r.applied) return "APPLIED";
  const why = r.reason ?? "";
  if (why === "already_final") return "ALREADY_FINAL";
  if (why === "lookup_failed") return "LOOKUP_FAILED";
  if (why === "unknown_txn" || why === "not_found_at_gateway") return "UNKNOWN_ORDER";
  if (why === "no_gateway_credentials") return "NOT_CONNECTED";
  if (why.startsWith("still ")) return "NOT_FINAL";
  return "NOT_APPLIED";
}

export function recordGatewayWebhook(e: GatewayWebhookEvent): void {
  void (async () => {
    let orderId: string | null = null, merchant = e.merchantId ?? null;
    if (e.txnId) {
      const p = await rows<{ id: string; merchant_id: string | null }>("vendorGateway",
        `SELECT id::text, merchant_id FROM vendor_payin_orders WHERE vendor = 'KATANA' AND vendor_txn_id = $1 LIMIT 1`, [e.txnId]).catch(() => []);
      if (p[0]) { orderId = p[0].id; merchant = merchant ?? p[0].merchant_id; }
      else {
        const c = await rows<{ id: string; merchant_id: string | null }>("checkout",
          `SELECT id::text, merchant_id FROM checkout_orders WHERE txn_id = $1 LIMIT 1`, [e.txnId]).catch(() => []);
        if (c[0]) { orderId = c[0].id; merchant = merchant ?? c[0].merchant_id; }
      }
    }
    await rows("vendorGateway", `
      INSERT INTO gateway_webhook_events (gateway, merchant_id, txn_id, order_id, signature_ok, outcome, gateway_status)
      VALUES ($1, $2, $3, $4::uuid, $5, $6, $7)
    `, [e.gateway.toUpperCase(), merchant, e.txnId?.slice(0, 120) ?? null, orderId, e.signatureOk ?? null, e.outcome, e.status ?? null]);
  })().catch((err) => console.warn("[gateway-webhook-log] not recorded:", (err as Error).message));
}
