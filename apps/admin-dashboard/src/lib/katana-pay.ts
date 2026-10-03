// Katana Pay — the pay-in order core shared by both flows (P2P and Intent, lib/payin-flow):
// the UPI link an order is paid with, the status rules every reader applies, the amount-forced
// outcomes of TEST orders, and the hash that signs Katana's callbacks.
//
// PURE apart from `crypto`: no database, no network.

import { createHash } from "crypto";

const PAYEE_VPA = "sandbox@test"; // sandbox payee for TEST orders: "@test" is no bank handle, so no UPI app can pay it
/** Every TEST order pays this — never a merchant's real UPI ID (lib/katana-order.ts). */
export const SANDBOX_PAYEE_VPA = PAYEE_VPA;
const PAYEE_NAME = "Katana Pay";

export interface DeepLinks {
  paytm: string;
  phonepe: string;
  upi: string; // generic UPI intent (also used as the QR payload)
}

// Build the UPI parameter string shared by every app deeplink and the QR.
//
// A MERCHANT'S OWN UPI ID IS NOT OUR COLLECT VPA, AND THE LINK MUST NOT PRETEND IT IS.
// UPI apps (Google Pay first) risk-score a payment link against the payee's registered
// account and decline the ones that look forged: "Payment to this receiver was declined".
// For a merchant-supplied payee (typically a static BharatPe / Paytm QR ID) that means:
//   pn  only the name registered with the bank (katana_pay.payee_name), else left out — never
//       our brand, which the app sees as a mismatch against the verified banking name.
//   tr  left out — a transaction reference on a static-QR payee is the acquirer's to issue,
//       and an outsider's value is a forgery signal. Nothing reads it back: the reconciler
//       matches on the order id in the note, the bank UTR, or amount + payee VPA.
// The sandbox collect VPA keeps pn + tr as before. Values are percent-encoded (%20, not +):
// Google Pay prints a '+' in the note literally.
export function buildUpiQuery(opts: { payeeVpa?: string; payeeName?: string | null; orderId: string; amount: number; note?: string }): string {
  const merchantPayee = !!opts.payeeVpa && opts.payeeVpa !== PAYEE_VPA;
  const name = merchantPayee ? opts.payeeName?.trim() || null : PAYEE_NAME;
  const params: [string, string | null][] = [
    ["pa", opts.payeeVpa ?? PAYEE_VPA],
    ["pn", name],
    ["tr", merchantPayee ? null : opts.orderId],
    ["am", opts.amount.toFixed(2)],
    ["cu", "INR"],
    ["tn", opts.note ?? `Order ${opts.orderId}`],
  ];
  return params
    .filter((p): p is [string, string] => !!p[1])
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

export function buildDeeplinks(query: string): DeepLinks {
  return {
    paytm: `paytmmp://pay?${query}`,
    phonepe: `phonepe://pay?${query}`,
    upi: `upi://pay?${query}`,
  };
}

// Sandbox status decision. An S2S order does NOT settle on its own — like the real
// flow, it stays PENDING until the payer pays and a webhook/UTR confirms it (the
// /confirm endpoint or the vendor callback). Only the pending-expiry rule and the
// amount-forced test outcomes change status automatically:
//   ...13  -> FAILED  (customer declined / U30)
//   ...11  -> EXPIRED (collect request lapsed / U69)
//   ...99  -> SUCCESS (forced success, ~8s — for testing the happy path)
//   else   -> PENDING (awaits confirmation / webhook / pending-expiry)
//
// CRITICAL: these amount-based outcomes are TEST hooks only. On real merchant
// traffic they would auto-FAIL / auto-EXPIRE / auto-SUCCEED any order whose amount
// happens to end in .13 / .11 / .99 paise — with NO payment ever made.
//
// THE ORDER'S MODE DECIDES, NOT AN ENVIRONMENT FLAG. They used to switch on for EVERY order
// when a sandbox-outcomes environment flag was set, so setting it on a production server would have auto-settled
// a real ₹499.99 order. They now apply to TEST orders only — always, so testers can use them on
// production — and never to a live order, whatever the environment says. The flag is retired.
// A live order stays PENDING until a REAL confirmation (agent bank-credit alert, vendor webhook,
// or manual ops) or the pending-expiry timeout — it never changes state on its own.
export function decideKatanaStatus(
  amountMinor: number,
  ageSeconds: number,
  livemode = true,
): { status: "PENDING" | "SUCCESS" | "FAILED" | "EXPIRED"; response_code: string } {
  if (!livemode) {
    if (amountMinor % 100 === 13) return { status: "FAILED", response_code: "U30" };
    if (amountMinor % 100 === 11) return { status: "EXPIRED", response_code: "U69" };
    if (amountMinor % 100 === 99 && ageSeconds >= 8) return { status: "SUCCESS", response_code: "00" }; // forced test success
  }
  return { status: "PENDING", response_code: "U17" }; // default: awaits real confirmation
}

export const KATANA_TERMINAL = new Set(["SUCCESS", "SUCCEEDED", "FAILED", "EXPIRED"]);

// Map an order status → the (STATUS, RESPONSE_CODE) a merchant's status callback carries.
export function callbackStatus(status: string): { STATUS: string; RESPONSE_CODE: string } {
  switch (status) {
    case "SUCCESS": case "SUCCEEDED": return { STATUS: "Captured", RESPONSE_CODE: "000" };
    case "FAILED": return { STATUS: "Failed", RESPONSE_CODE: "004" };
    case "EXPIRED": return { STATUS: "Expired", RESPONSE_CODE: "003" };
    default: return { STATUS: status, RESPONSE_CODE: "005" };
  }
}

// A status callback is sent ONCE PER STATUS, not once per order. EXPIRED and FAILED are soft
// terminals: a payment that lands afterwards revives the order to SUCCESS (lib/katana-order),
// and the merchant, already told "Expired" or "Failed", must then be told "Captured". The stamp
// left by the earlier callback (meta.callback) only blocks a repeat of that same status.
// "Captured" is hard final: once a merchant has been told it, nothing else is ever sent.
export function payinCallbackSent(
  stamp: { sent_at?: string; status?: string } | null | undefined,
  orderStatus: string,
): boolean {
  if (!stamp?.sent_at) return false;
  if (!stamp.status || stamp.status === "Captured") return true;
  return callbackStatus(orderStatus).STATUS === stamp.status;
}

// Which gateway orders are still worth asking their gateway about (a SQL condition on
// vendor_payin_orders). A paid order never is. One the gateway has not answered for is, until
// the caller's own age limit. One the gateway answered "failed" for is asked again for two more
// hours: on a hosted payment page a declined attempt can be followed by one that goes through,
// and that payment must not be stranded on a FAILED order.
export const GATEWAY_RECHECK_SQL = `status NOT IN ('SUCCESS','SUCCEEDED')
       AND ((status <> 'FAILED' AND COALESCE(meta->'gateway'->>'final', '') = '')
            OR created_at >= now() - interval '2 hours')`;

// What staff are told when a gateway was asked about an order and nothing changed (the "Force
// status refresh" action). `reason` and `lookupError` are what the gateway check returned
// (lib/gateway-payin, lib/payu-result). The text can carry a gateway's name and its own words,
// so it is for staff only: a merchant session gets GATEWAY_CHECK_NOTE_MERCHANT instead.
export function gatewayCheckNote(r: { status: string; reason?: string; lookupError?: string }): string {
  const why = r.reason ?? "";
  if (r.lookupError) return `The gateway gave no usable answer: ${r.lookupError}`;
  if (why === "no_gateway_credentials") return "The gateway could not be asked: this merchant's saved gateway credentials are missing or belong to another gateway";
  if (why === "checked_recently") return "The gateway was asked moments ago; try again in a few seconds";
  if (why === "not_found_at_gateway") return "The gateway has no order under this reference";
  if (why === "already_final") return "The gateway's answer matches the order; nothing to change";
  if (why.startsWith("still ")) return `The gateway says the payment is ${why.slice(6).toUpperCase() || "not final"}; nothing was changed`;
  if (r.status === "SUCCESS") return `The gateway says the payment went through, but it was not applied: ${why || "unknown reason"}`;
  if (r.status === "FAILED") return `The gateway says the payment failed; the order was left as it is${why ? ` (${why})` : ""}`;
  return why ? `The gateway's answer was not applied: ${why}` : "The gateway gave no final answer";
}
export const GATEWAY_CHECK_NOTE_MERCHANT = "The payment processor has not confirmed a payment for this order";

// Auto-resolution pause. The status enquiry / poller normally advances a PENDING
// order over time (sandbox amount rule + pending-expiry). It must NOT do so while
// the order is parked for a human decision: a high-amount hold (meta.hold) or a
// sender payment proof awaiting ops verification (meta.review === 'PROOF_SUBMITTED').
// Pausing here stops a proof-bearing order from silently expiring before review.
export function autoResolvePaused(meta: { hold?: boolean; review?: string } | null | undefined): boolean {
  return meta?.hold === true || meta?.review === "PROOF_SUBMITTED";
}

// Stable 12-digit RRN derived from the order id (so repeated enquiries match).
export function genRrn(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 1_000_000_000_000;
  return h.toString().padStart(12, "0");
}

// Status-intelligence rules ------------------------------------------------
// Pending-expiry: a pay-in still PENDING past this age is force-EXPIRED so it
// never hangs forever (sandbox 15 min; tune per provider SLA when live).
export const PENDING_EXPIRY_SECONDS = 900;

// Two clocks, not one. PENDING_EXPIRY_SECONDS is the CUSTOMER's time to pay. A live order that
// was sent to a gateway is then held PENDING for a further confirmation window, which is OUR
// time to hear from the gateway: a gateway can confirm a payment well after the customer made
// it, and expiring at 15 minutes tells the merchant "Expired" and then "Captured". In the
// window the customer is offered no way to start a payment; the order only waits.
//
// The window is off (0) until set, so nothing changes by default:
//   PAYIN_CONFIRM_WINDOW_SECONDS            every gateway
//   PAYIN_CONFIRM_WINDOW_SECONDS_<GATEWAY>  one gateway, which wins (e.g. _PAYU)
// A P2P order (no gateway) and a test order have no window.
export const CONFIRM_WINDOW_MAX_SECONDS = 24 * 3600;

type OrderMeta = { gateway?: { provider?: unknown } | null } | null | undefined;

export function confirmWindowSeconds(
  meta: OrderMeta,
  livemode = true,
  env: Record<string, string | undefined> = process.env,
): number {
  const provider = meta?.gateway?.provider;
  if (!livemode || typeof provider !== "string" || !provider) return 0;
  const own = env[`PAYIN_CONFIRM_WINDOW_SECONDS_${provider.toUpperCase()}`];
  const n = Math.floor(Number(own != null && own !== "" ? own : env.PAYIN_CONFIRM_WINDOW_SECONDS));
  return Number.isFinite(n) && n > 0 ? Math.min(n, CONFIRM_WINDOW_MAX_SECONDS) : 0;
}

/** The age at which a PENDING order is given up on: the customer's time plus the confirmation window. */
export function orderExpirySeconds(meta: OrderMeta, livemode = true, env: Record<string, string | undefined> = process.env): number {
  return PENDING_EXPIRY_SECONDS + confirmWindowSeconds(meta, livemode, env);
}

/** True while the customer's time is over and the order is only waiting for its gateway. */
export function inConfirmWindow(
  status: string, ageSeconds: number, meta: OrderMeta, livemode = true,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !KATANA_TERMINAL.has(status) && ageSeconds >= PENDING_EXPIRY_SECONDS
    && ageSeconds < orderExpirySeconds(meta, livemode, env);
}

// Single source of truth for resolving a Katana Pay order's status. Enforces the
// final-status lock (terminal never re-resolves), then the deterministic sandbox
// decision, then the pending-expiry rule. Used by the status enquiry, the cron
// sweep poller, and the force-refresh action so they can never disagree.
// `expirySeconds` is the order's own limit (orderExpirySeconds).
export function resolveKatanaStatus(
  currentStatus: string,
  amountMinor: number,
  ageSeconds: number,
  livemode = true,
  expirySeconds = PENDING_EXPIRY_SECONDS,
): { status: string; response_code: string; changed: boolean } {
  if (KATANA_TERMINAL.has(currentStatus)) {
    return { status: currentStatus, response_code: "", changed: false }; // final-status lock
  }
  const d = decideKatanaStatus(amountMinor, ageSeconds, livemode);
  let status = d.status, code = d.response_code;
  if (status === "PENDING" && ageSeconds >= expirySeconds) {
    status = "EXPIRED"; code = "U69"; // pending-expiry
  }
  return { status, response_code: code, changed: status !== currentStatus };
}

// ── The Katana hash: SHA256 over the sorted fields ──────────────────────────────
//
// Signs the status callback Katana sends a merchant (lib/merchant-callback) and the payout
// callbacks (lib/payout-api); a merchant verifies it with their Salt.
//
//   1. take the request name/value pairs (excluding HASH)
//   2. sort keys ascending, join as KEY=value with "~" as separator
//   3. append the SECRET_KEY directly to the end of the string (no separator)
//   4. SHA256 the string, hex-encode, UPPERCASE
//
// Empty values are kept as KEY= (the guide signs CUST_STREET_ADDRESS1= for blanks).
export function buildKatanaSignString(params: Record<string, unknown>): string {
  // Code-unit (ASCII) sort — NOT localeCompare. The guide's param names are
  // uppercase ASCII and the gateway sorts by raw byte order; localeCompare could
  // reorder underscores vs letters and break the hash.
  const keys = Object.keys(params)
    .filter((k) => k.toUpperCase() !== "HASH")
    .sort();
  return keys.map((k) => {
    const v = params[k];
    return `${k}=${v === null || v === undefined ? "" : String(v)}`;
  }).join("~");
}

export function signKatanaHash(params: Record<string, unknown>, secret: string): string {
  const base = buildKatanaSignString(params) + secret;
  return createHash("sha256").update(base, "utf8").digest("hex").toUpperCase();
}

export function verifyKatanaHash(
  params: Record<string, unknown>,
  secret: string,
  providedHash: string,
): boolean {
  const expected = signKatanaHash(params, secret);
  const got = (providedHash ?? "").toUpperCase();
  // length-guarded constant-ish compare
  if (expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
