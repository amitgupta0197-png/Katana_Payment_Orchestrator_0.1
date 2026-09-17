// What every pay-in connector (Razorpay, Cashfree, CCAvenue, PhonePe, Paytm) provides.
//
// PayU keeps its own proven path (lib/payu, lib/payu-intent, lib/payu-result). The other
// gateways plug in here, and lib/gateway-payin drives them through the same order flows:
// the hosted checkout and UPI intent on /api/pay, Katana Pay orders, and test payments.
//
// Confirmation never trusts a callback body. A webhook or browser return only tells Katana
// WHICH order to look at; the connector's status() call — authenticated with the merchant's
// own credentials and answered by the gateway — decides what happened. Nothing here throws,
// and a call that got no usable answer is "unknown", never "failed".

import type { GatewayMid } from "@/lib/gateway-creds";
import type { GatewayId } from "@/lib/pg-catalog";

export type PayinCall<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface PayinOrder {
  txnid: string;          // Katana's reference, sent as the gateway's order id
  amountMinor: bigint;    // paise
  currency: string;
  productinfo: string;
  firstname: string;
  email: string;
  phone: string;
  /** Where the customer's browser comes back to (Katana's return route for this gateway). */
  returnUrl: string;
  /** Where the gateway posts server-to-server events (Katana's webhook route for this gateway). */
  notifyUrl: string;
}

export interface PayinClient {
  ip: string;
  deviceInfo: string;
}

/** How to send the customer's browser to the gateway. */
export type CheckoutStart =
  | { kind: "redirect"; url: string }
  | { kind: "form"; url: string; fields: Record<string, string> }
  | { kind: "html"; html: string };

export interface PayinState {
  found: boolean;
  /** SUCCESS / FAILED once the gateway is sure; null while the customer can still pay. */
  final?: "SUCCESS" | "FAILED" | null;
  status?: string;          // the gateway's own word, verbatim
  paymentId?: string;       // the gateway's payment id
  bankRef?: string;         // UTR / RRN
  amountMinor?: bigint;
  mode?: string;
  error?: string;
  raw?: Record<string, unknown>;
}

export interface PayinConnector {
  id: GatewayId;
  name: string;
  /** Start a hosted checkout. */
  checkout(mid: GatewayMid, o: PayinOrder, client: PayinClient): Promise<PayinCall<CheckoutStart>>;
  /** Get a UPI intent server-to-server (no gateway page). Gateways without one omit it. */
  upiIntent?(mid: GatewayMid, o: PayinOrder, client: PayinClient): Promise<PayinCall<{ intentQuery: string; paymentId: string | null }>>;
  /** What the gateway says happened to the order Katana created as `txnid`. */
  status(mid: GatewayMid, txnid: string): Promise<PayinCall<PayinState>>;
}

export function publicBase(): string {
  return (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
}

export const payinReturnUrl = (id: GatewayId, txnid: string) =>
  `${publicBase()}/api/gateway/${id.toLowerCase()}/return?txnid=${encodeURIComponent(txnid)}`;
export const payinWebhookUrl = (id: GatewayId) => `${publicBase()}/api/gateway/${id.toLowerCase()}/webhook`;

export function rupees(minor: bigint): string {
  const neg = minor < 0n; const v = neg ? -minor : minor;
  return `${neg ? "-" : ""}${v / 100n}.${(v % 100n).toString().padStart(2, "0")}`;
}

export function paiseFrom(v: unknown): bigint | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? BigInt(Math.round(n * 100)) : undefined;
}

/** A UPI intent's query string (pa=…&am=…), from a bare query or a full upi:// / app URI. */
export function intentQueryOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    const q = s.indexOf("?");
    if (q < 0) return null;
    s = s.slice(q + 1);
  }
  const p = new URLSearchParams(s);
  if (!p.get("pa") || !p.get("am")) return null;
  return s.replace(/ /g, "%20");
}

export function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A page that POSTs the customer's browser to the gateway. */
export function autoSubmitPage(url: string, fields: Record<string, string>, gatewayName: string): string {
  const inputs = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}"/>`).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Redirecting to ${esc(gatewayName)}…</title></head>
<body onload="document.forms[0].submit()">
<p style="font-family:sans-serif">Taking you to ${esc(gatewayName)} to pay…</p>
<form method="post" action="${esc(url)}">
${inputs}
<noscript><button type="submit">Continue to payment</button></noscript>
</form></body></html>`;
}

/** Render any checkout start as an HTML page for the customer's browser. */
export function checkoutPage(start: CheckoutStart, gatewayName: string): string {
  if (start.kind === "html") return start.html;
  if (start.kind === "form") return autoSubmitPage(start.url, start.fields, gatewayName);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${esc(start.url)}"><title>Redirecting to ${esc(gatewayName)}…</title></head>
<body><p style="font-family:sans-serif">Taking you to ${esc(gatewayName)} to pay… <a href="${esc(start.url)}">Continue</a></p></body></html>`;
}

/**
 * Gateways take real payments only once a sandbox payment has been seen end to end. PayU is
 * proven; the others are switched on per gateway with PAYIN_CONNECTORS_PROD=PAYU,RAZORPAY,...
 */
export function payinProdEnabled(id: string): boolean {
  const list = (process.env.PAYIN_CONNECTORS_PROD ?? "PAYU").split(",").map((s) => s.trim().toUpperCase());
  return list.includes(id.toUpperCase());
}
