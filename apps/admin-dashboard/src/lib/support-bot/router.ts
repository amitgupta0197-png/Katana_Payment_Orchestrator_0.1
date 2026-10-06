// Which model answers a question (lib/support-bot). PURE: decided by rules, with no model call,
// so routing itself costs nothing.
//
//   LIGHT     Claude Haiku 4.5    general "how do I…" questions about Katana
//   STANDARD  Claude Sonnet 5.5   a question about their own case: an order, a payment, an error,
//                                 a webhook or payout that went wrong, an id or UTR in the text
//   HEAVY     Claude Opus 5.5     a screenshot to read, or a long paste (logs, code) to work through
//
// Every tier has the same instructions and lookups; a light question that turns out to need a
// lookup still gets one. SUPPORT_BOT_ROUTING=off sends everything to HEAVY.

export type Tier = "LIGHT" | "STANDARD" | "HEAVY";

export interface ModelChoice {
  tier: Tier;
  model: string;
  /** output_config.effort; null for a model that does not take it. */
  effort: "low" | "medium" | null;
  /** Server-side refusal fallback ("default" form); only where the model accepts it. */
  fallbacks: boolean;
  /**
   * $ per million tokens: input, output, cache read, cache write for the 5-minute cache and for the
   * 1-hour cache. Anthropic prices a 5-minute write at 1.25x input and a 1-hour write at 2x input.
   */
  price: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number };
}

export const MODELS: Record<Tier, ModelChoice> = {
  LIGHT: { tier: "LIGHT", model: "claude-haiku-4-5", effort: null, fallbacks: false,
    price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 } },
  STANDARD: { tier: "STANDARD", model: "claude-sonnet-5-5", effort: "medium", fallbacks: true,
    price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 } },
  HEAVY: { tier: "HEAVY", model: "claude-opus-5-5", effort: "medium", fallbacks: true,
    price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 } },
};

/** Text that points at the merchant's own case rather than a general question. */
const CASE_SIGNS: RegExp[] = [
  /\b\d{12}\b/,                                   // a UTR / RRN
  /\bKTN_[0-9a-f]{6,}/i, /\b(P2P|INT)-\w+/i,      // Katana order ids
  /\b[A-Z]{1,8}[-_]?\d{3,}\b/,                    // a txnid such as T-1042 or ORD12345
  /\b(4\d\d|5\d\d)\b/,                            // an HTTP status
  /\b[A-Z]{3,}_[A-Z_]{3,}\b/,                     // an error code such as FLOW_NOT_ENABLED
  /fail|expir|stuck|pending|declin|reject|refus|revers|mismatch|error|wrong|problem|issue|missing|not (been )?(received|reach|arriv|credit|show|work|get|got|come)|didn'?t|did not|never (got|came|arrived)|no (webhook|callback)|deducted|debited|on hold/i,
  /\b(my|our|last|this|that|yesterday|today'?s?) (order|payment|payout|transaction|txn|webhook|callback|request|customer)/i,
];

const LONG_PASTE = 1_500;

export function chooseModel(q: { question: string; images: number; env?: Record<string, string | undefined> }): ModelChoice {
  const env = q.env ?? process.env;
  if (env.SUPPORT_BOT_ROUTING === "off") return MODELS.HEAVY;
  if (q.images > 0 || q.question.length > LONG_PASTE) return MODELS.HEAVY;
  if (CASE_SIGNS.some((r) => r.test(q.question))) return MODELS.STANDARD;
  return MODELS.LIGHT;
}

/**
 * Telegram: cheaper by default. Haiku unless the message carries a concrete case (an order id, a
 * txnid, a UTR, a KP- support reference, a pasted error) or a screenshot, which go to Sonnet.
 * Opus is never used on Telegram. Pure, no model call.
 */
const TG_CASE_SIGNS: RegExp[] = [
  /\b\d{12}\b/,                                   // a UTR / RRN
  /\bKTN_[0-9a-f]{6,}/i, /\b(P2P|INT)-\w+/i,      // Katana order ids
  /\b[A-Z0-9]{2,}[-_][A-Z0-9-_]{4,}\b/,             // a txnid such as BBUY88-1791… or LT-…
  /\bKP-[0-9A-F]{8}\b/,                            // a Katana support reference
  /[{[]\s*"|"error"\s*:|\b[A-Z]{3,}_[A-Z_]{3,}\b/,  // a pasted JSON body or an error code
];

export function chooseTelegramModel(q: { question: string; images: number; env?: Record<string, string | undefined> }): ModelChoice {
  const env = q.env ?? process.env;
  if (env.SUPPORT_BOT_ROUTING === "off") return MODELS.STANDARD;
  if (q.images > 0 || TG_CASE_SIGNS.some((r) => r.test(q.question))) return MODELS.STANDARD;
  return MODELS.LIGHT;
}

/**
 * $ for the tokens a turn used, at the prices of the model that answered. `cacheWrite1h` is the
 * part of cacheWrite written to the 1-hour cache (priced at 2x input instead of 1.25x).
 */
export function costEstimate(u: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number }, price = MODELS.HEAVY.price): number {
  const w1h = Math.min(u.cacheWrite1h ?? 0, u.cacheWrite);
  const usd = u.input * price.input + u.output * price.output + u.cacheRead * price.cacheRead
    + (u.cacheWrite - w1h) * price.cacheWrite + w1h * price.cacheWrite1h;
  return Math.round(usd / 1e6 * 10_000) / 10_000;
}
