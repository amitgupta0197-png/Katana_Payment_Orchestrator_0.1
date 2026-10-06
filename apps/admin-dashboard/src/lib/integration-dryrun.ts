// "Test my integration" (merchant and banker portals): a merchant pastes the order request it
// sends, and Katana says whether it would be accepted, without creating an order or asking any
// gateway. PURE: lib/integration-dryrun-store runs the same checks the order API runs
// (lib/katana-order-api) and this turns their answers into plain words for the merchant.
//
// Everything here is shown to a merchant: no gateway is named (lib/merchant-safe), no Salt or
// secret is shown, and a key that isn't the merchant's own reads exactly like an unknown key.

import type { OrderFlow } from "@/lib/payin-flow";
import type { SigVerdict } from "@/lib/support-bot/signature";

export interface DryRunProblem {
  /** The code the order API would answer with, when it has one. */
  code: string;
  title: string;
  fix: string;
}

export interface DryRunResult {
  /** True when the order API would take this request. */
  accepted: boolean;
  /** One sentence for the top. */
  headline: string;
  /** The banker the Key belongs to (only one of the merchant's own), when it was found. */
  banker: string | null;
  livemode: boolean | null;
  endpoint: string;
  problems: DryRunProblem[];
  /** True and useful, but not a refusal. */
  notes: string[];
  /** What was checked and passed, in order. */
  passed: string[];
}

export const ORDER_PATHS: Record<string, OrderFlow | null> = {
  "/api/v1/katana-pay/order": null,
  "/api/v1/p2p/order": "P2P",
  "/api/v1/intent/order": "INTENT",
};

export interface ParsedRequest {
  /** The order endpoint the request went to; the general one when no URL was pasted. */
  endpoint: string;
  /** The flow that endpoint asks for (null = the general API). */
  flow: OrderFlow | null;
  /** The host the URL pointed at, when one was pasted. */
  host: string | null;
  body: Record<string, unknown> | null;
  error: string | null;
}

/**
 * What was pasted: a JSON body, a curl command (as Postman exports it), or a chat message with
 * the JSON somewhere in it. Only the order endpoint and the body are taken.
 */
export function parseRequestText(text: string): ParsedRequest {
  const t = (text ?? "").trim();
  const url = /https?:\/\/[^\s'"\\]+/i.exec(t)?.[0] ?? null;
  let endpoint = "/api/v1/katana-pay/order", host: string | null = null, flow: OrderFlow | null = null;
  if (url) {
    try {
      const u = new URL(url);
      host = u.host;
      const path = u.pathname.replace(/\/+$/, "");
      if (path in ORDER_PATHS) { endpoint = path; flow = ORDER_PATHS[path]; }
      else endpoint = path || "/";
    } catch { /* not a URL after all */ }
  }
  // The body: a curl --data '...', else the outermost {...} in what was pasted.
  const data = /(?:--data-raw|--data-binary|--data|-d)\s+(['"])([\s\S]*?)\1(?=\s|$)/.exec(t)?.[2];
  let raw = data ?? null;
  if (!raw) {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    raw = a >= 0 && b > a ? t.slice(a, b + 1) : null;
  }
  if (!raw) return { endpoint, flow, host, body: null, error: "Paste the order request: the JSON body, or the whole curl command." };
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return { endpoint, flow, host, body: body as Record<string, unknown>, error: null };
  } catch {
    return { endpoint, flow, host, body: null, error: "The body isn't valid JSON. Check for a missing comma or quote." };
  }
}

/** Why a hash didn't match, said to the merchant (lib/support-bot/signature works out which). */
export const SIGNATURE_FIX: Record<SigVerdict, string> = {
  CORRECT: "The hash looks right for this request. Send the full hash, not cut short, in the same request.",
  AMOUNT_FORMAT: "You signed the amount written differently from the amount you sent (for example 499 and 499.00). Sign exactly the amount string you send.",
  MISSING_FIELDS: "You left productinfo or email out of the signed string, but sent them. Sign every field you send, in order. A field you don't send is signed as empty.",
  SALT_KEY_ORDER: "You used Salt + Key as the HMAC key. It must be your Key, then your Salt, with nothing between.",
  OTHER_MODE_SALT: "You used the Salt of the other mode. The test key needs the test Salt, the live key the live Salt.",
  PLAIN_SHA256: "You used plain SHA-256. Use HMAC-SHA256, with your Key + Salt as the HMAC key.",
  SHA256_WITH_SALT: "You used SHA-256 with the Salt added at the end. Use HMAC-SHA256, with your Key + Salt as the HMAC key.",
  UPPERCASE: "The hash is right but in capital letters. Send it in small letters.",
  WRONG_SCHEME: "You used the other signing method. Use the one your key was made with.",
  UNKNOWN: "It matches none of the usual mistakes. Print the exact string you sign and compare it with the one below, character by character.",
};

/** A reason the order path would stop a live order, from "Check this banker", in merchant words. */
export function setupProblem(key: string): DryRunProblem | null {
  switch (key) {
    case "BLOCKED": case "SUSPENDED": case "MERCHANT_SUSPENDED":
      return { code: "MERCHANT_BLOCKED", title: "Your account is paused, so orders are refused.", fix: "Contact Katana support." };
    case "LIVE_MODE":
      return { code: "LIVE_MODE_NOT_ACTIVATED", title: "Live payments aren't switched on for this account yet.", fix: "Test with your test key until Katana switches live payments on." };
    case "PAYIN_NOT_ENABLED":
      return { code: "PAYIN_NOT_ENABLED", title: "This account is set up for payouts only.", fix: "Ask Katana to switch on payments in (pay-ins) if you need them." };
    case "PARTNER_ONLY":
      return { code: "PARTNER_ONLY", title: "This account takes orders from its partner only.", fix: "Send the order through your partner, or ask Katana to allow your own orders." };
    case "NO_UPI_ID": case "NO_PAYMENT_ACCOUNT": case "NO_FLOW": case "ACCOUNT_NOT_USABLE": case "ACCOUNT_SANDBOX":
      return { code: "FLOW_NOT_READY", title: "Katana hasn't finished setting up the payment account for this account.", fix: "Nothing to change on your side. Contact Katana support." };
    default:
      return null;
  }
}

/** The blockers that stop a test order too (a test order needs no live setup). */
export const BLOCKS_TEST_ORDERS = new Set(["BLOCKED", "SUSPENDED", "MERCHANT_SUSPENDED", "PAYIN_NOT_ENABLED", "PARTNER_ONLY"]);

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export interface AmountFacts {
  min: number | null; max: number | null; upiMax: number | null;
  /** The payment account's own minimum (live only). */
  accountMin: number | null;
  /** While the account is being verified, the largest payment it takes. */
  verifyCap: number | null;
}

/** The amount checks the order path makes before any gateway is asked (lib/payin-limits, lib/gateway-golive). */
export function amountProblems(amount: number, livemode: boolean, f: AmountFacts): DryRunProblem[] {
  const out: DryRunProblem[] = [];
  if (!Number.isFinite(amount) || amount <= 0) return [{ code: "INVALID_AMOUNT", title: "The amount isn't a number above zero.", fix: 'Send it in rupees as a string, for example "499.00".' }];
  if (!livemode) return out;
  const min = Math.max(f.min ?? 0, f.accountMin ?? 0);
  if (min > 0 && amount < min) out.push({ code: "AMOUNT_BELOW_MIN", title: `${inr(amount)} is below the minimum of ${inr(min)}.`, fix: `Send ${inr(min)} or more.` });
  const max = [f.max, f.upiMax].filter((x): x is number => x != null && x > 0).reduce((a, b) => Math.min(a, b), Infinity);
  if (Number.isFinite(max) && amount > max) out.push({ code: "AMOUNT_ABOVE_MAX", title: `${inr(amount)} is above the maximum of ${inr(max)}.`, fix: `Send ${inr(max)} or less.` });
  if (f.verifyCap != null && amount > f.verifyCap)
    out.push({ code: "ACCOUNT_NOT_LIVE", title: `Your payment account is still being verified, so only payments up to ${inr(f.verifyCap)} work for now.`, fix: `Test with ${inr(Math.max(min, Math.min(f.verifyCap, max)))} until Katana sets it live.` });
  return out;
}

/** The answer the merchant sees, in the order the order API would check. */
export function dryRunResult(r: Omit<DryRunResult, "accepted" | "headline">): DryRunResult {
  const accepted = r.problems.length === 0;
  return {
    ...r, accepted,
    headline: accepted
      ? `This ${r.livemode ? "live" : "test"} order would be accepted.`
      : `This order would be refused: ${r.problems.length === 1 ? "1 thing to fix" : `${r.problems.length} things to fix`}.`,
  };
}
