// The public status of a Katana pay-in order: what the hosted pay page polls and what a
// merchant reads back. Shared by GET /api/pay-status/{id} and the per-flow status endpoints
// (GET /api/v1/p2p/order/{id}, GET /api/v1/intent/order/{id}).

import { rows, pgError } from "@/lib/pg";
import {
  resolveKatanaStatus, orderExpirySeconds, inConfirmWindow, genRrn, KATANA_TERMINAL, autoResolvePaused, PENDING_EXPIRY_SECONDS,
} from "@/lib/katana-pay";
import { sendPayinCallback } from "@/lib/merchant-callback";
import { checkPayuPayinNow } from "@/lib/payu-result";
import { checkGatewayPayin } from "@/lib/gateway-payin";
import { publicBase } from "@/lib/payin-providers/types";

export interface PayStatusPayload {
  order_id: string; amount: number; currency_code: string; status: string;
  terminal: boolean; proof_submitted: boolean; rrn: string | null;
  mode: string; deeplinks: unknown; upi_intent: unknown; return_url: string | null;
  merchant_name: string | null; payee_vpa: string | null;
  held: boolean; expires_at: string | null; completed_at: string | null;
  // The customer's time to pay is over and the order is waiting for its payment processor to
  // confirm (the confirmation window, lib/katana-pay). `confirm_until` is when it stops waiting.
  confirming: boolean; confirm_until: string | null;
  livemode: boolean;   // false = a test order; the pay page labels it so nobody mistakes it for real
  checkout_url: string | null;   // hosted-page orders (PayU Client ID, RubyVault, iSmartPay): Katana's link to the page the customer pays on
  checkout_methods: "ALL" | "UPI" | null;   // what that page takes: UPI only, or cards / net banking / wallets too
}

// The payee name (pn) and VPA (pa) are already public inside the UPI intent the
// customer is shown; surface them as fields so the page can say who is being paid.
function upiParam(intent: unknown, key: string): string | null {
  if (typeof intent !== "string" || !intent.includes("?")) return null;
  try { return new URLSearchParams(intent.split("?").slice(1).join("?")).get(key) || null; }
  catch { return null; }
}

// Read the order's current public status, running the same age-based auto-resolution
// (pending-expiry) the poll has always done. Returns null when the order is absent.
export async function readOrderStatus(id: string): Promise<PayStatusPayload | null> {
  const found = await rows<any>("vendorGateway", `
    SELECT id::text, order_id, amount, currency_code, COALESCE(rrn,'') AS rrn,
           status, meta, created_at, updated_at, livemode, vendor_txn_id, merchant_id,
           EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
      FROM vendor_payin_orders
     WHERE id = $1::uuid AND vendor = 'KATANA'
  `, [id]);
  if (!found.length) return null;

  let order = found[0];

  // A PayU order is settled by PayU. Ask PayU directly (at most every 4s per order, however many
  // pages are polling) so the page flips within seconds of the customer approving in their UPI app,
  // instead of waiting for PayU's webhook or the sweep.
  // Other gateways (Razorpay, Cashfree, PhonePe, Paytm) are asked the same way.
  const provider = order.meta?.gateway?.provider;
  if (provider && order.livemode !== false && !KATANA_TERMINAL.has(order.status)) {
    // PayU with a Client ID + Secret is asked through its connector, like the other gateways.
    const payuKeySalt = provider === "PAYU" && order.meta?.gateway?.auth !== "client_credentials";
    // Past the customer's time to pay the order may wait much longer (the confirmation window);
    // an open page then asks the gateway every 30s, not every 4s.
    const throttle = order.age_seconds >= PENDING_EXPIRY_SECONDS ? 30 : 4;
    const r = payuKeySalt
      ? await checkPayuPayinNow(order.vendor_txn_id, order.merchant_id, throttle).catch(() => ({ applied: false }))
      : await checkGatewayPayin({ provider, txnid: order.vendor_txn_id, merchantCode: order.merchant_id, source: "pay_page", throttleSec: throttle })
          .catch(() => ({ applied: false }));
    if (r.applied) return readOrderStatus(id);
  }

  if (!autoResolvePaused(order.meta)) { // high-amount holds + proofs await manual review
    const amountMinor = Math.round(Number(order.amount) * 100);
    const live = order.livemode !== false;
    const decision = resolveKatanaStatus(order.status, amountMinor, order.age_seconds, live, orderExpirySeconds(order.meta, live));
    if (decision.changed) {
      const rrn = decision.status === "SUCCESS" ? genRrn(order.id) : null;
      // The order was read before the gateway was asked, so it may have been confirmed since.
      // A final order is never written over: the guard makes this a no-op and the fresh row is read.
      const upd = await rows<any>("vendorGateway", `
        UPDATE vendor_payin_orders
           SET status = $2, response_code = $3, rrn = COALESCE($4, rrn), updated_at = now()
         WHERE id = $1::uuid AND status NOT IN ('SUCCESS','SUCCEEDED','FAILED','EXPIRED')
        RETURNING id::text, order_id, amount, currency_code, COALESCE(rrn,'') AS rrn, status, meta, created_at, updated_at, livemode
      `, [order.id, decision.status, decision.response_code, rrn]);
      if (!upd.length) return readOrderStatus(id);
      order = upd[0];
      // Auto-resolution just flipped this order terminal — fire the merchant
      // status callback (idempotent; no-op if already sent or no target).
      if (KATANA_TERMINAL.has(order.status)) sendPayinCallback(order.id).catch(() => {});
    }
  }

  const meta = order.meta ?? {};
  const terminal = KATANA_TERMINAL.has(order.status);
  const held = autoResolvePaused(meta);
  const createdAt = order.created_at ? new Date(order.created_at) : null;
  const live = order.livemode !== false;
  const ageSeconds = createdAt ? Math.floor((Date.now() - createdAt.getTime()) / 1000) : 0;
  const confirming = !held && inConfirmWindow(order.status, ageSeconds, meta, live);
  return {
    confirming,
    confirm_until: confirming && createdAt
      ? new Date(createdAt.getTime() + orderExpirySeconds(meta, live) * 1000).toISOString() : null,
    merchant_name: upiParam(meta.upi_intent, "pn") ?? (typeof meta.merchant_name === "string" ? meta.merchant_name : null),
    payee_vpa: upiParam(meta.upi_intent, "pa"),
    held,
    livemode: order.livemode !== false,
    // Held orders wait for an operator and never expire, so they get no countdown. This is the
    // customer's time to pay; a gateway order may wait longer for its confirmation (confirm_until).
    expires_at: !terminal && !held && createdAt
      ? new Date(createdAt.getTime() + PENDING_EXPIRY_SECONDS * 1000).toISOString() : null,
    // When the payment was confirmed, where that is recorded: updated_at also moves when the
    // callback is stamped, so on its own it can show the notification time instead.
    completed_at: !terminal ? null
      : typeof meta.confirmation?.at === "string" ? meta.confirmation.at
      : order.updated_at ? new Date(order.updated_at).toISOString() : null,
    order_id: order.order_id,
    amount: Number(order.amount),
    currency_code: order.currency_code,
    status: order.status,
    terminal: KATANA_TERMINAL.has(order.status),
    proof_submitted: meta.review === "PROOF_SUBMITTED",
    rrn: order.rrn || null,
    mode: meta.mode ?? "QR",
    deeplinks: meta.deeplinks ?? null,
    upi_intent: meta.upi_intent ?? null,
    return_url: meta.return_url ?? null,   // browser redirect target after payment
    // This response is public (the customer's pay page and the merchant's status polling), so
    // it never names the gateway (lib/merchant-safe): the page is reached through Katana's own
    // link (/pay/{id}/go), never by its address, and only what it can be paid with is said.
    checkout_url: typeof meta.gateway?.checkout_url === "string" ? `${publicBase()}/pay/${order.id}/go` : null,
    checkout_methods: typeof meta.gateway?.checkout_url === "string" ? (meta.gateway.provider === "PAYU" ? "ALL" : "UPI") : null,
  };
}

