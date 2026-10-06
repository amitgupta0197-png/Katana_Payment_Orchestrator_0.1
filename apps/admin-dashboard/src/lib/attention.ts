// "Needs attention" (/attention): one list, across every banker, of what a person should look at
// before a merchant notices. PURE: lib/attention-store reads the facts (with the same functions the
// banker page's "Check this banker" uses) and this turns them into ranked rows in plain words.
// STAFF ONLY: rows may name a gateway.

export const ATTENTION_CATEGORIES = [
  "REFUSES_LIVE", "PAID_NOT_TOLD", "CALLBACK_FAILING", "WRONG_CREDENTIALS", "UNMATCHED_MONEY",
  "STUCK_PENDING", "PHONE_OFFLINE", "REFUSALS", "VERIFYING_STUCK",
] as const;
export type AttentionCategory = (typeof ATTENTION_CATEGORIES)[number];

/** Label, how bad it is (1 = worst) and the note behind the ⓘ, for each category. */
export const CATEGORY: Record<AttentionCategory, { label: string; severity: 1 | 2 | 3; info: string }> = {
  REFUSES_LIVE: { label: "Can't take live orders", severity: 1,
    info: "A live banker whose next live order would be refused. Open it and fix the first problem shown." },
  PAID_NOT_TOLD: { label: "Paid, merchant not told", severity: 1,
    info: "A customer paid, but the merchant's server never got the payment message. Tell the merchant, or resend when their server works." },
  CALLBACK_FAILING: { label: "Payment messages failing", severity: 2,
    info: "Katana could not deliver payment messages to the merchant's server. Their server is down or refusing them." },
  WRONG_CREDENTIALS: { label: "Wrong gateway keys", severity: 1,
    info: "The gateway says the saved keys are wrong, so orders fail. Ask the banker for the right live keys and save them again." },
  UNMATCHED_MONEY: { label: "Money with no order", severity: 1,
    info: "Money arrived, but Katana could not tell which order it was for. Link it to the right order, or mark it as not an order payment." },
  STUCK_PENDING: { label: "Orders stuck waiting", severity: 2,
    info: "Orders still waiting long after they should have ended. The status check may be failing for this banker." },
  VERIFYING_STUCK: { label: "Payment account not live yet", severity: 3,
    info: "A new payment account still takes only small test payments. Make one real payment, then set it live on Gateway go-live." },
  PHONE_OFFLINE: { label: "Payment phone offline", severity: 2,
    info: "The phone that reads this banker's payments is offline. UPI payments to the banker can't be confirmed until it is back." },
  REFUSALS: { label: "Many refused orders", severity: 3,
    info: "The merchant sent many orders today that Katana refused for the same reason. Their integration probably has one mistake." },
};

export interface AttentionItem {
  /** Stable id of the condition: snoozes are keyed on it. */
  key: string;
  category: AttentionCategory;
  bankerCode: string;
  /** The banker's merchants.id, for links; null when unknown. */
  bankerId: string | null;
  merchantName: string | null;
  title: string;
  detail: string;
  /** When the condition started (or the oldest occurrence), ISO. */
  since: string | null;
  /** How many occurrences (orders, credits, refusals), for sorting inside a category. */
  count: number;
  fix: { label: string; href: string } | null;
}

export interface AttentionView {
  items: (AttentionItem & { severity: 1 | 2 | 3; categoryLabel: string })[];
  counts: Record<AttentionCategory, number>;
  snoozed: number;
}

/** A link to a tab of the staff banker page. */
export const bankerHref = (bankerId: string | null, bankerCode: string, tab?: string): string =>
  `/bankers/${encodeURIComponent(bankerId ?? bankerCode)}${tab ? `?tab=${tab}` : ""}`;

/**
 * Rank the rows: worst category first, then the most occurrences, then the oldest. Rows whose
 * key is snoozed until after `now` are left out (and counted).
 */
export function attentionView(items: AttentionItem[], snoozedUntil: Map<string, string>, now: Date = new Date()): AttentionView {
  const counts = Object.fromEntries(ATTENTION_CATEGORIES.map((c) => [c, 0])) as Record<AttentionCategory, number>;
  let snoozed = 0;
  const shown: AttentionView["items"] = [];
  const seen = new Set<string>();
  for (const i of items) {
    if (seen.has(i.key)) continue;
    seen.add(i.key);
    const until = snoozedUntil.get(i.key);
    if (until && new Date(until).getTime() > now.getTime()) { snoozed++; continue; }
    counts[i.category]++;
    shown.push({ ...i, severity: CATEGORY[i.category].severity, categoryLabel: CATEGORY[i.category].label });
  }
  const order = (c: AttentionCategory) => ATTENTION_CATEGORIES.indexOf(c);
  shown.sort((a, b) =>
    a.severity - b.severity || order(a.category) - order(b.category) || b.count - a.count
    || (a.since ?? "9999").localeCompare(b.since ?? "9999") || a.bankerCode.localeCompare(b.bankerCode));
  return { items: shown, counts, snoozed };
}

/** A banker gets a REFUSALS row only for a code it was refused with this often in 24 hours. */
export const REFUSALS_MIN = 5;
/** A payment account still VERIFYING after this long is shown. */
export const VERIFYING_HOURS = 24;
