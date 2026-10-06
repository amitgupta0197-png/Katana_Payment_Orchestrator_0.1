// A banker's integration, tracked: callback URLs per flow, their reachability checks and a health
// score per flow (merchant 0019). PURE: the store is lib/integration-store, the checks are
// lib/callback-verify.
//
// Callback URLs. A banker has its default webhook_url (merchants) and may have one per flow
// (banker_callback_urls: INTENT / P2P / PAYOUT). A per-flow URL that is PENDING or VERIFIED is
// where that flow's callbacks go; with none, or a FAILED one, they go to the default as before.
// A per-order notify_url still wins over both (lib/merchant-callback).
//
// A check is reachability: Katana POSTs a signed test event and any 2xx passes. When the answer
// is JSON with an `echo` field it must equal the challenge sent; otherwise no echo is needed.
//
// Staff only.

export const CALLBACK_FLOWS = ["INTENT", "P2P", "PAYOUT"] as const;
export type CallbackFlow = (typeof CALLBACK_FLOWS)[number];
export type CallbackStatus = "PENDING" | "VERIFIED" | "FAILED";

export const FLOW_LABEL: Record<CallbackFlow, string> = { INTENT: "Intent pay-ins", P2P: "P2P pay-ins", PAYOUT: "Payouts" };

/** Failures in a row that make a URL FAILED (and the alert red). One is amber. */
export const FAIL_AFTER = 3;
/** A pass older than this no longer counts as "verified recently". */
export const VERIFIED_FRESH_HOURS = 24;
/** The scheduled check re-checks a URL not checked for this long. */
export const RECHECK_HOURS = 6;

export const parseCallbackFlow = (v: unknown): CallbackFlow | null =>
  typeof v === "string" && (CALLBACK_FLOWS as readonly string[]).includes(v.toUpperCase()) ? (v.toUpperCase() as CallbackFlow) : null;

// ── Which URL a callback goes to ────────────────────────────────────────────────────────────

const isHttp = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u.trim());

/** A per-flow row's URL when callbacks may use it (PENDING or VERIFIED, with a URL), else null. */
export function usableFlowUrl(row: { url: string | null; status: string } | null | undefined): string | null {
  if (!row || !isHttp(row.url)) return null;
  return row.status === "PENDING" || row.status === "VERIFIED" ? row.url.trim() : null;
}

/**
 * Where a callback goes: the order's own notify_url, else the flow's URL, else the banker's
 * default. `fallback` is whatever the sender chose before per-flow URLs existed.
 */
export function chooseCallbackTarget(o: { notifyUrl?: string | null; flowUrl?: string | null; fallback: string | null }): string | null {
  // The notify_url test and value are exactly what the senders used before.
  if (o.notifyUrl && /^https?:\/\//i.test(o.notifyUrl)) return o.notifyUrl;
  if (isHttp(o.flowUrl)) return o.flowUrl.trim();
  return o.fallback;
}

/** The flow of a pay-in's channel; null for one with no flow (UNCLASSIFIED, legacy). */
export function payinCallbackFlow(channelType: string | null | undefined): CallbackFlow | null {
  return channelType === "INTENT" || channelType === "P2P" ? channelType : null;
}

// ── A URL's state after a check ─────────────────────────────────────────────────────────────

export type AlertLevel = "NONE" | "AMBER" | "RED";

export interface CheckState { status: CallbackStatus; consecutive_failures: number }

/**
 * The state after one check. A pass makes it VERIFIED and clears the count; a failure counts,
 * and the third in a row makes it FAILED. One or two failures keep the status it had (a URL
 * still PENDING stays PENDING) and raise an amber alert; three raise a red one.
 */
export function afterCheck(prev: CheckState, ok: boolean): CheckState & { alert: AlertLevel } {
  if (ok) return { status: "VERIFIED", consecutive_failures: 0, alert: "NONE" };
  const n = prev.consecutive_failures + 1;
  return { status: n >= FAIL_AFTER ? "FAILED" : prev.status, consecutive_failures: n, alert: n >= FAIL_AFTER ? "RED" : "AMBER" };
}

/** One alert per banker and flow (flow null = the default webhook URL). */
export const callbackAlertKey = (merchantCode: string, flow: CallbackFlow | null) => `callback:${merchantCode}:${flow ?? "DEFAULT"}`;

/**
 * A merchant's server that answers the test event (ORDER_ID "integration-check", an order it has
 * never seen) with one of these is up and reading our callbacks: it rejected an unknown order,
 * which is right. Reachable, with a note; never a failure.
 */
export const REACHABLE_4XX = new Set([400, 404, 409, 422]);

/**
 * Whether a check's answer passes: a 2xx (and the echo when the body is JSON carrying one), or one
 * of REACHABLE_4XX with a note. 5xx, redirects, timeouts and connection errors fail.
 */
export function pingPasses(httpStatus: number | null, body: string, challenge: string): { ok: boolean; error: string | null; note?: string } {
  if (httpStatus == null) return { ok: false, error: "no answer" };
  if (REACHABLE_4XX.has(httpStatus))
    return { ok: true, error: null, note: `your server answered ${httpStatus} for the test order (integration-check): that's fine if it rejects unknown orders` };
  if (httpStatus < 200 || httpStatus > 299) return { ok: false, error: `HTTP ${httpStatus}` };
  let parsed: unknown = null;
  try { parsed = JSON.parse(body); } catch { /* not JSON: no echo needed */ }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "echo" in parsed) {
    const echo = (parsed as { echo: unknown }).echo;
    if (echo !== challenge) return { ok: false, error: "echo did not match the challenge" };
  }
  return { ok: true, error: null };
}

/** The status of the default URL, worked out from its pings (newest first) to the current URL. */
export function stateFromPings(pings: { ok: boolean; url: string }[], url: string | null): CheckState & { checked: boolean } {
  const mine = url ? pings.filter((p) => p.url === url) : [];
  if (!mine.length) return { status: "PENDING", consecutive_failures: 0, checked: false };
  let n = 0;
  for (const p of mine) { if (p.ok) break; n += 1; }
  if (n === 0) return { status: "VERIFIED", consecutive_failures: 0, checked: true };
  const everPassed = mine.some((p) => p.ok);
  return { status: n >= FAIL_AFTER ? "FAILED" : everPassed ? "VERIFIED" : "PENDING", consecutive_failures: n, checked: true };
}

/** First problem with a callback URL a person typed, or null. */
export function callbackUrlProblem(url: string): string | null {
  const u = url.trim();
  if (u.length > 2000) return "the URL is too long";
  let p: URL;
  try { p = new URL(u); } catch { return "not a URL"; }
  if (p.protocol !== "https:" && p.protocol !== "http:") return "the URL must start with https://";
  if (p.username || p.password) return "the URL must not carry a user name or password";
  return null;
}

// ── Which flows a banker is on ──────────────────────────────────────────────────────────────

/**
 * The flows the score covers. Services and the pay-in flow come from the merchant (lib/
 * merchant-services, lib/payin-flow); for a merchant nobody chose for, the flows it has used in
 * the last 30 days.
 */
export function activeFlows(services: "PAYIN" | "PAYOUT" | "BOTH" | "UNSET", payinFlows: ("P2P" | "INTENT")[], payinFlowUnset: boolean, seen: CallbackFlow[]): CallbackFlow[] {
  const out: CallbackFlow[] = [];
  if (services !== "PAYOUT") {
    const pf: CallbackFlow[] = payinFlowUnset ? seen : payinFlows;
    for (const f of ["INTENT", "P2P"] as const) if (pf.includes(f)) out.push(f);
  }
  if (services === "PAYOUT" || services === "BOTH" || (services === "UNSET" && seen.includes("PAYOUT"))) out.push("PAYOUT");
  return out;
}

// ── Health score ────────────────────────────────────────────────────────────────────────────

export interface FlowFacts {
  /** A Key + Salt for the mode the banker is in (live once LIVE, else either). */
  keyActive: boolean;
  /** Where this flow's callbacks go now (per-flow or default); null = nowhere. */
  callbackUrl: string | null;
  /** When that URL last passed a check. */
  lastVerifiedAt: string | null;
  /** A successful live or test payment (payout for PAYOUT) on this flow in 30 days. */
  successIn30d: boolean;
  webhookVersion: "v1" | "v2";
  hasSigningSecret: boolean;
}

export interface ScoreItem { key: string; label: string; ok: boolean }

export function flowItems(f: FlowFacts, now: Date = new Date()): ScoreItem[] {
  const fresh = !!f.lastVerifiedAt && now.getTime() - new Date(f.lastVerifiedAt).getTime() <= VERIFIED_FRESH_HOURS * 3600_000;
  const items: ScoreItem[] = [
    { key: "key", label: "Key + Salt issued", ok: f.keyActive },
    { key: "callback_url", label: "Callback URL set", ok: !!f.callbackUrl },
    { key: "verified", label: `Callback URL passed a check in the last ${VERIFIED_FRESH_HOURS} hours`, ok: !!f.callbackUrl && fresh },
    { key: "payment", label: "A successful payment in the last 30 days", ok: f.successIn30d },
  ];
  if (f.webhookVersion === "v2") items.push({ key: "secret", label: "Webhook signing secret made", ok: f.hasSigningSecret });
  return items;
}

/** 0–100: items passed over items. */
export function scoreOf(items: ScoreItem[]): number {
  if (!items.length) return 100;
  return Math.round((items.filter((i) => i.ok).length / items.length) * 100);
}

export type Band = "GREEN" | "AMBER" | "RED" | "GREY";
export const bandOf = (score: number | null): Band => (score == null ? "GREY" : score >= 90 ? "GREEN" : score >= 60 ? "AMBER" : "RED");

/** The banker's overall score: its weakest flow's, null when it is on no flow. */
export function overallScore(scores: number[]): number | null {
  return scores.length ? Math.min(...scores) : null;
}

/** A callback status as a chain colour. */
export function callbackBand(status: CallbackStatus | null, consecutiveFailures = 0): Band {
  if (!status) return "GREY";
  if (status === "FAILED") return "RED";
  if (consecutiveFailures > 0 || status === "PENDING") return "AMBER";
  return "GREEN";
}
