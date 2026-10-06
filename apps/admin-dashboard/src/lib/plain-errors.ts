// What a refused order means, in plain words, for staff screens (the banker page's "Orders we
// refused today", "Check this banker"). One place, so every screen says the same thing. The API's
// own codes and messages are not changed: merchants still get those exactly as documented.

export interface PlainRefusal {
  /** Why the order was refused, as a person would say it. */
  text: string;
  /** Where staff fix it: a banker-page tab or a page. */
  fix?: { label: string; tab?: string; href?: string };
  /** The merchant has to change something, not Katana. */
  merchantSide?: boolean;
}

const BY_CODE: Record<string, PlainRefusal> = {
  FLOW_NOT_READY: { text: "no payment account connected for this flow", fix: { label: "Connect a payment account", tab: "intent" } },
  SETUP_INCOMPLETE: { text: "the payment setup isn't finished", fix: { label: "See what's left", tab: "overview" } },
  FLOW_NOT_SELECTED: { text: "no payment flow is chosen", fix: { label: "Choose how customers pay", tab: "overview" } },
  FLOW_NOT_ENABLED: { text: "the order asked for a flow this account isn't on", merchantSide: true },
  FLOW_NOT_ALLOWED: { text: "the order asked for a flow this account isn't on", merchantSide: true },
  LIVE_MODE_NOT_ACTIVATED: { text: "live payments aren't switched on yet", fix: { label: "Open live mode", tab: "developer" } },
  ACCOUNT_NOT_LIVE: { text: "the payment account is still being verified, so only small payments are taken", fix: { label: "Open Gateway go-live", href: "/gateway-golive" } },
  PARTNER_ONLY: { text: "its merchant is an exclusive partner, so orders signed with this banker's own key are refused", fix: { label: "Open partner settings", href: "/partners" } },
  PAYIN_NOT_ENABLED: { text: "its merchant is set up for payouts only", fix: { label: "Open merchant readiness", href: "/merchant-readiness" } },
  MERCHANT_BLOCKED: { text: "this banker is blocked", fix: { label: "Open payment settings", tab: "overview" } },
  MERCHANT_SUSPENDED: { text: "this banker or its merchant is suspended" },
  NO_ACCOUNT_AVAILABLE: { text: "none of its payment accounts could take the order (limits, hours or health)", fix: { label: "Open the MID switch", href: "/mid-switch" } },
  AMOUNT_BELOW_MIN: { text: "the amount is below this account's minimum", merchantSide: true, fix: { label: "Open limits", tab: "overview" } },
  AMOUNT_ABOVE_MAX: { text: "the amount is above this account's maximum", merchantSide: true, fix: { label: "Open limits", tab: "overview" } },
  UPI_LIMIT_EXCEEDED: { text: "the amount is above the UPI limit", merchantSide: true },
  DAILY_LIMIT_EXCEEDED: { text: "today's total limit is used up", fix: { label: "Open limits", tab: "overview" } },
  RATE_LIMITED: { text: "too many orders at once", merchantSide: true },
  SIGNATURE_MISMATCH: { text: "the order's hash didn't match its Key + Salt", merchantSide: true },
  NO_KEY: { text: "the order was signed with a key Katana doesn't know", merchantSide: true },
  TXNID_IN_USE: { text: "the txnid was already used", merchantSide: true },
  INVALID_REQUEST: { text: "a field in the order was missing or wrong", merchantSide: true },
  PAYOUT_NOT_ENABLED: { text: "its merchant isn't set up for payouts" },
};

// Refusals that carry no code: the processor's own answer, already scrubbed for merchants.
const BY_TEXT: [RegExp, PlainRefusal][] = [
  [/minimum amount should be (\d+)/i, { text: "the amount is below the payment account's minimum", merchantSide: true }],
  [/rate-limiting|too many requests|HTTP 429/i, { text: "the payment account refused the request: check its saved credentials", fix: { label: "Open the payment account", tab: "intent" } }],
  [/did not start the checkout|did not return a UPI intent|non-JSON reply/i, { text: "the payment processor didn't start the payment", fix: { label: "Check this banker", tab: "overview" } }],
  [/unreachable|timed out|aborted/i, { text: "the payment processor didn't answer in time" }],
];

/** A refused order in plain words: by its code, else by the text of its error. */
export function plainRefusal(code: string | null | undefined, error?: string | null): PlainRefusal {
  if (code && BY_CODE[code]) return BY_CODE[code];
  const e = error ?? "";
  for (const [re, p] of BY_TEXT) {
    const m = e.match(re);
    if (m) return m[1] && re.source.includes("minimum") ? { ...p, text: `the amount is below the payment account's minimum of ₹${m[1]}` } : p;
  }
  return { text: e ? e.replace(/\s*If this continues.*$/i, "").replace(/\.$/, "") : "the order was refused" };
}

// ── Onboarding stage checks (lib/onboarding-gates), as the advance dialog shows them ──────────

const GATE_WORDS: Record<string, string> = {
  APPLICATION: "Application", WEBSITE: "Website", DOCUMENTS: "Documents", SCREENING: "Sanctions check",
  MID_ISSUANCE: "Bank-issued IDs", SETUP: "Payment setup",
};

const GATE_SUMMARY_WORDS: [RegExp, string][] = [
  [/the banker is on no TSP/i, "no TSP is recorded for this banker. Only needed when a bank issues it IDs; payments through a connected payment account don't need one"],
  [/the banker has no issuing bank/i, "no issuing bank is recorded for this banker"],
  [/takes Intent pay-ins but has no active Intent MID/i, "it takes gateway payments but has no active bank-issued Intent ID"],
  [/no TSPs in use yet/i, "no TSP is used yet: gateway payments go through the connected payment account, checked at Approval"],
];

/** "MID_ISSUANCE: the banker is on no TSP; SETUP: …" → plain words, one check per sentence. */
export function plainGateMessage(msg: string | null | undefined): string {
  if (!msg) return "";
  return msg.split(/;\s*/).map((part) => {
    const m = part.match(/^([A-Z_]+):\s*(.*)$/);
    if (!m) return part;
    let summary = m[2];
    for (const [re, words] of GATE_SUMMARY_WORDS) if (re.test(summary)) { summary = words; break; }
    return `${GATE_WORDS[m[1]] ?? m[1]}: ${summary}`;
  }).join(". ");
}
