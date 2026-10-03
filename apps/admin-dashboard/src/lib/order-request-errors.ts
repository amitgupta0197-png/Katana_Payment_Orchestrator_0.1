// What a refused v1 order request says, in words a developer can act on (lib/katana-order-api).
//
// A request with a missing or malformed field used to be answered with the validator's own dump
// (`[{"code":"too_small","path":["hash"],…}]`), which names nothing the developer typed. A
// merchant's test page sending order_id / signature / customer_email (2026-10-03) got exactly that
// and could not tell what was wrong. Pure: no request, no database.

import type { ZodError } from "zod";
import { LEGACY_ORDER_STRING } from "@/lib/starter-kit";

/** Field names developers send by habit from other gateways, and the one Katana reads. */
const WRONG_NAMES: Record<string, string> = {
  order_id: "txnid", orderid: "txnid", txn_id: "txnid", reference: "txnid", merchant_order_id: "txnid",
  signature: "hash", sign: "hash", checksum: "hash",
  customer_email: "email", customer_name: "firstname", name: "firstname",
  customer_phone: "phone", mobile: "phone", product: "productinfo", description: "productinfo",
  redirect_url: "return_url", callback_url: "notify_url", webhook_url: "notify_url",
};

/** The signing rule for a key's scheme: HMAC-SHA256 for every pair issued now, SHA-512 for older ones. */
export function signingRuleFor(scheme: string | null | undefined): string {
  if (scheme === "PAYU_SHA512" || scheme === "SHA512_LEGACY")
    return `hash = SHA-512 hex of ${LEGACY_ORDER_STRING} (ten empty fields between email and salt).`;
  return SIGNING_RULE;
}

export const SIGNING_RULE =
  "hash = HMAC-SHA256 hex of txnid|amount|productinfo|email, keyed with your Key and Salt joined (Key first, no space). Leave a field you don't send empty in its place; send the amount exactly as you signed it.";

export interface OrderRequestError {
  error: string;
  code: "INVALID_REQUEST";
  /** Required fields that were missing or empty. */
  missing: string[];
  /** Fields present but not valid, with why. */
  invalid: { field: string; problem: string }[];
  /** "you sent order_id: Katana reads txnid", one per wrongly named field sent. */
  hints: string[];
}

export function describeOrderRequestError(raw: unknown, err: ZodError): OrderRequestError {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const missing: string[] = [];
  const invalid: { field: string; problem: string }[] = [];
  for (const i of err.issues) {
    const field = i.path.join(".") || "body";
    const v = body[field];
    if (v === undefined || v === null || v === "") { if (!missing.includes(field)) missing.push(field); }
    else invalid.push({ field, problem: i.message });
  }
  const hints = Object.keys(body)
    .filter((k) => WRONG_NAMES[k.toLowerCase()] && !(WRONG_NAMES[k.toLowerCase()] in body))
    .map((k) => `you sent "${k}": Katana reads "${WRONG_NAMES[k.toLowerCase()]}"`);
  const parts = [
    missing.length ? `missing: ${missing.join(", ")}` : null,
    invalid.length ? `not valid: ${invalid.map((x) => `${x.field} (${x.problem})`).join(", ")}` : null,
  ].filter(Boolean);
  return { error: `invalid request: ${parts.join("; ") || "body could not be read"}`, code: "INVALID_REQUEST", missing, invalid, hints };
}
