// RULE: a merchant never learns which payment gateway sits behind Katana.
//
// PayU, Razorpay, Cashfree, CCAvenue, PhonePe PG, Paytm PG, RubyVault, iSmartPay and any
// gateway added later are Katana's own business. Their names, their error text, their support
// addresses and their ids must not reach a merchant: not in an API response, not in a callback,
// not on the hosted pay page, not in the provider or branch portal, not in the public guides.
//
// "Merchant" here is everyone who is not Katana staff: a request signed with a merchant
// Key + Salt, a PROVIDER or MERCHANT session, and the public (the customer on the pay page).
// Super Admin screens keep the real names: operators need them to fix a gateway problem.
//
// Internal code keeps writing precise messages ("PayU did not return a UPI intent (EX087): …")
// and storing them for operators. This file is the boundary: every merchant-facing response
// goes through merchantSafeBody / merchantSafeError, which swap the name for "payment
// processor", drop the gateway's own words, and log the full text under a reference the
// merchant can quote to support.
//
// PURE apart from the log line (no `pg`, no server-only imports): portals import it too.

import { GATEWAYS } from "@/lib/pg-catalog";

// Catalog ids and names, plus gateways that are wired outside the catalog. Longest first so
// "Cashfree Payments" is replaced whole, not left as "payment processor Payments".
const NAMES = [...new Set([
  ...GATEWAYS.flatMap((g) => [g.name, g.name.split(" ")[0], g.id]),
  "Airpay", "Paytech",
])].sort((a, b) => b.length - a.length);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAME_SRC = NAMES.map(esc).join("|");

/** True when the text names a gateway. */
export function namesGateway(text: string | null | undefined): boolean {
  return !!text && new RegExp(NAME_SRC, "i").test(text);
}

/** The text with every gateway name replaced (default "gateway"). For labels and log-style lines. */
export function stripGatewayNames(text: string, replacement = "gateway"): string {
  return text.replace(new RegExp(NAME_SRC, "gi"), replacement);
}

const PROCESSOR = "payment processor";
const FALLBACK = "The payment processor did not accept the request";

function supportRef(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += "0123456789ABCDEF"[Math.floor(Math.random() * 16)];
  return `KP-${s}`;
}

/**
 * The text a merchant is shown for an error. A message that names no gateway is returned
 * unchanged. One that does keeps only Katana's own clause (everything before the gateway's
 * quoted reply or our operator hint), with the name replaced, and gains a support reference;
 * the full text is logged under that reference.
 */
export function merchantSafeError(detail: string, where: string): string {
  if (!namesGateway(detail)) return detail;
  const ref = supportRef();
  console.error(`[merchant-safe] ref=${ref} at=${where} ${detail}`);
  let s = detail.split(/: | — /)[0]
    .replace(new RegExp(`^(?:${NAME_SRC})(?:'s)?`, "i"), (m) => (/'s$/i.test(m) ? `The ${PROCESSOR}'s` : `The ${PROCESSOR}`))
    .replace(new RegExp(NAME_SRC, "gi"), PROCESSOR)
    .replace(/\s+/g, " ").trim()
    .replace(/processor unreachable$/, "processor is unreachable");
  if (!s || namesGateway(s)) s = FALLBACK;
  s = s[0].toUpperCase() + s.slice(1);
  return `${s.replace(/[.;,]+$/, "")}. If this continues, contact Katana support with reference ${ref}.`;
}

// Response keys that carry a gateway's id or name.
const GATEWAY_KEYS = new Set(["gateway", "gateway_name", "channel_id"]);
// Keys named after a gateway, and the neutral key the value moves to.
const RENAMED_KEYS: Record<string, string> = { payu_payment_id: "gateway_payment_id" };

/**
 * A JSON response body made safe for a merchant: `error` goes through merchantSafeError,
 * keys that hold a gateway id or name are dropped (also inside `order`), and keys named
 * after a gateway are renamed.
 */
export function merchantSafeBody(body: Record<string, unknown>, where: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (GATEWAY_KEYS.has(k)) continue;
    if (k === "error" && typeof v === "string") out[k] = merchantSafeError(v, where);
    else if (k === "order" && v && typeof v === "object" && !Array.isArray(v))
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([ok]) => !GATEWAY_KEYS.has(ok)));
    else out[RENAMED_KEYS[k] ?? k] = v;
  }
  return out;
}

/**
 * The signing scheme as a merchant sees it. The stored id of the older scheme is named after
 * a gateway; a merchant gets a neutral id, and merchantSchemeIn maps it back.
 */
export function merchantSafeScheme<T extends string | null | undefined>(scheme: T): T | "SHA512_LEGACY" {
  return scheme === "PAYU_SHA512" ? "SHA512_LEGACY" : scheme;
}

/** Staff see gateway names; every other persona is a merchant for the purposes of this rule. */
export function seesGatewayNames(persona: string | null | undefined): boolean {
  return !!persona && !["PROVIDER", "MERCHANT", "BANKER"].includes(persona);
}

/**
 * The label a merchant sees for the rail or vendor a transaction ran on. Katana's own rail
 * keeps its product name; every gateway is just "Gateway".
 */
export function merchantSafeChannel(channel: string | null | undefined): string {
  const c = (channel ?? "").trim();
  if (!c || c === "—") return "—";
  // Katana's own rail. POOLPAY is the code the routing engine's rails still carry for it.
  if (c.toUpperCase() === "KATANA" || c.toUpperCase() === "POOLPAY") return "Katana Pay";
  if (c.toUpperCase() === "DIRECT") return "Direct";
  return namesGateway(c) ? "Gateway" : c;
}
