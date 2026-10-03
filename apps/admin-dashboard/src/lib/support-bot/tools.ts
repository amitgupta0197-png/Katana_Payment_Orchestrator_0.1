// The support bot's tools: read-only lookups into the data of the bankers in scope.
//
// The bankers are fixed by the server from the conversation's scope (lib/support-bot/scope,
// ToolContext): one banker, or every banker of one merchant. No tool takes a merchant code from
// the model, so the bot cannot be talked into reading another account; every query is limited
// to ctx.codes, and each row says which of the merchant's own accounts it belongs to.
// Each tool returns only the fields an answer needs, through the merchant view of the data
// (portal scope staff: false), and every result passes stripGatewayNames before the model sees
// it (lib/merchant-safe). Customer details (UPI IDs, phone numbers) are never returned, and no
// Salt or secret is: the signature check says which mistake was made, not what the Salt is.

import type Anthropic from "@anthropic-ai/sdk";
import { rows } from "@/lib/pg";
import { stripGatewayNames } from "@/lib/merchant-safe";
import { starterKitFacts } from "@/lib/starter-kit-store";
import { readApiLog } from "@/lib/api-log";
import { orderTimeline, readDeliveries, searchOrders } from "@/lib/order-timeline";
import { payoutView, PAYOUT_VIEW_COLS } from "@/lib/payout-api";
import { getCheckoutCreds } from "@/lib/merchant-checkout";
import { settlementVpasFor } from "@/lib/settlement-vpa";
import { traceRows } from "@/lib/payment-search";
import { v2OrderId, v2Status } from "@/lib/webhook-v2";
import { diagnoseOrderSignature, parseHashHint, type OrderFields } from "@/lib/support-bot/signature";

export interface ToolContext {
  /** The bankers every lookup is limited to. Never empty when a tool runs. */
  codes: string[];
  /** Banker code to name, to label rows when the scope has more than one banker. */
  names?: Record<string, string>;
}

/** "Greenleaf Stores (BOTDEMO1)": which of the merchant's own accounts a row belongs to. */
const accountOf = (ctx: ToolContext, code: string | null | undefined) =>
  code ? `${ctx.names?.[code] ?? code} (${code})` : null;

const MAX_RESULT_CHARS = 9_000;

type Tool = Anthropic.Beta.BetaTool;

const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object" as const, properties, required, additionalProperties: false });

export const SUPPORT_BOT_TOOLS: Tool[] = [
  {
    name: "get_account_setup",
    description: "How this merchant account is set up: services (pay-in, pay-out or both), pay-in flow (P2P, Intent or both, and the default), webhook URL and format, test and live keys (keys only, never Salts), live mode status with its checklist, limits, and whether it is blocked. Use it first for most questions. When the merchant has several accounts, it lists each one briefly.",
    input_schema: obj({}),
    strict: true,
  },
  {
    name: "list_recent_requests",
    description: "The account's recent calls to the order APIs (last 7 days, newest first): time, endpoint, HTTP status, error code, test or live key, the order fields they sent (txnid, amount, productinfo, email), a hint of the hash, and the error Katana answered with. Use it for any error the merchant got from the API.",
    input_schema: obj({
      only_errors: { type: "boolean", description: "true: only requests that were refused (HTTP 400 or more)." },
      limit: { type: "integer", description: "How many, 1 to 20." },
    }, ["only_errors", "limit"]),
    strict: true,
  },
  {
    name: "check_signature",
    description: "For one request from list_recent_requests that was refused with 'signature mismatch': works out which signing mistake produced the hash they sent (amount format, missing fields, Salt and Key swapped, the other mode's Salt, plain SHA-256, upper case, wrong scheme) and returns the exact string they should have signed. Never reveals the Salt.",
    input_schema: obj({ request_id: { type: "string", description: "The request_id from list_recent_requests." } }, ["request_id"]),
    strict: true,
  },
  {
    name: "find_order",
    description: "One pay-in order by the merchant's txnid, Katana's order id or the bank reference (RRN): status, amount, test or live, every status change with its time, when it expires, and every webhook delivery attempt for it with the HTTP status their server answered.",
    input_schema: obj({ reference: { type: "string", description: "txnid, order id or RRN, at least 3 characters." } }, ["reference"]),
    strict: true,
  },
  {
    name: "find_payment",
    description: "Trace one payment from what the merchant knows about it, usually read off a payment screenshot: the UPI reference (UTR / RRN, 12 digits), the amount, the time it was paid and the UPI ID it was paid to. Looks in two places: the money Katana saw arrive in the account (and whether it was matched to an order), and the orders with that amount around that time (or that bank reference). Give every value you have; null for the rest. Needs the UTR or the amount.",
    input_schema: obj({
      utr: { type: ["string", "null"], description: "The UPI reference / UTR / RRN, digits only." },
      amount_rupees: { type: ["number", "null"], description: "The amount paid, in rupees." },
      paid_at: { type: ["string", "null"], description: "When it was paid, in India time, as YYYY-MM-DD HH:MM." },
      paid_to_upi_id: { type: ["string", "null"], description: "The UPI ID the money was sent to, as shown on the screenshot." },
    }, ["utr", "amount_rupees", "paid_at", "paid_to_upi_id"]),
    strict: true,
  },
  {
    name: "list_webhook_deliveries",
    description: "The account's most recent webhook deliveries (all orders): event, target URL, delivered or still retrying or given up, and each attempt's HTTP status or error. Use it when webhooks are not arriving.",
    input_schema: obj({ limit: { type: "integer", description: "How many, 1 to 20." } }, ["limit"]),
    strict: true,
  },
  {
    name: "list_recent_payouts",
    description: "The account's most recent payouts, newest first: payout id, txnid, status, amount, rail, test or live, bank reference and failure reason.",
    input_schema: obj({ limit: { type: "integer", description: "How many, 1 to 20." } }, ["limit"]),
    strict: true,
  },
];

/** What the person sees while a lookup runs. */
export const TOOL_STEP_LABEL: Record<string, string> = {
  get_account_setup: "Checking your account setup",
  list_recent_requests: "Reading your recent API calls",
  check_signature: "Checking the signature",
  find_order: "Finding the order",
  find_payment: "Tracing the payment",
  list_webhook_deliveries: "Checking your webhooks",
  list_recent_payouts: "Checking your payouts",
};

const clampLimit =(v: unknown) => Math.min(Math.max(Math.trunc(Number(v) || 10), 1), 20);
/** A time as merchants in India read it: "03 Oct 2026, 06:30:33 IST". */
export function ist(d: unknown): string | null {
  if (!d) return null;
  const t = new Date(d as string);
  if (Number.isNaN(t.getTime())) return null;
  return `${t.toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} IST`;
}
const iso = ist;

/** The key's mode from its redacted hint ("mk_t…(24)"). */
function keyMode(hint: unknown): "test" | "live" | null {
  const s = typeof hint === "string" ? hint : "";
  return s.startsWith("mk_t") ? "test" : s.startsWith("mk_l") || s.startsWith("mk_") ? "live" : null;
}

// The order fields worth showing from a logged request body. Customer details stay out.
const SHOWN_FIELDS = ["txnid", "amount", "productinfo", "email", "currency", "mode", "reference", "return_url", "notify_url"] as const;

function requestSummary(body: Record<string, unknown> | null | undefined) {
  if (!body || typeof body !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const k of SHOWN_FIELDS) if (body[k] !== undefined) out[k] = body[k];
  if (body.firstname !== undefined) out.firstname_sent = true;
  if (body.hash !== undefined) out.hash_hint = body.hash;
  if (body.key !== undefined) out.key_mode = keyMode(body.key);
  return out;
}

function answerSummary(body: Record<string, unknown> | null | undefined) {
  if (!body || typeof body !== "object") return null;
  const order = body.order as Record<string, unknown> | undefined;
  const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  return {
    ...pick(body, ["error", "code", "field", "limit", "actual", "message", "flow", "reused", "livemode", "status"]),
    ...(order ? { order: pick(order, ["order_id", "status", "amount", "channel_type"]) } : {}),
  };
}

async function accountSetup(code: string) {
  const [k, m] = await Promise.all([
    starterKitFacts(code),
    rows<{ stage: string; blocked: boolean | null }>("merchant", `
      SELECT m.stage, c.blocked FROM merchants m LEFT JOIN merchant_payment_config c ON c.merchant_code = m.merchant_code
       WHERE m.merchant_code = $1`, [code]).catch(() => []),
  ]);
  return {
    name: k.bankerName, merchant_code: k.merchantCode, onboarding_stage: m[0]?.stage ?? null, blocked: m[0]?.blocked === true,
    services: k.services === "UNSET" ? "not chosen (pay-in and pay-out both allowed)" : k.services,
    payin_flow: k.flow.flow === "UNSET" ? "not chosen" : k.flow.flow,
    // The flow /api/v1/katana-pay/order takes: the only flow, or the default when both.
    general_endpoint_flow: k.flow.flow === "BOTH" ? k.flow.active : k.flow.flow === "UNSET" ? "decided by Katana per order" : k.flow.flow,
    webhook: { url: k.webhook.url, format: k.webhook.version, successful_payments_only: k.webhook.paidOnly, v2_signing_secret_set: !!k.webhook.secretHint },
    test_key: k.testCreds?.key ?? null, test_signing_scheme: k.testCreds ? k.testCreds.scheme : null,
    live_key: k.liveKey?.key ?? null,
    live_mode: k.liveMode, live_checklist: k.liveChecklist,
    live_payin_limits_rupees: k.limits,
    test_payouts_go_to: k.testPayouts === "SANDBOX" ? "Katana test sandbox (amount rules apply)" : "the payment processor's test system",
  };
}

const MAX_ACCOUNTS_DETAILED = 10;

async function getAccountSetup(ctx: ToolContext) {
  if (ctx.codes.length === 1) return accountSetup(ctx.codes[0]);
  // Several accounts: the facts that tell them apart, for the first few.
  const shown = ctx.codes.slice(0, MAX_ACCOUNTS_DETAILED);
  const all = await Promise.all(shown.map((c) => accountSetup(c).catch(() => null)));
  return {
    accounts_total: ctx.codes.length,
    accounts: all.filter(Boolean).map((a) => ({
      account: accountOf(ctx, a!.merchant_code), onboarding_stage: a!.onboarding_stage, blocked: a!.blocked,
      services: a!.services, payin_flow: a!.payin_flow, webhook_url: a!.webhook.url, live_mode: a!.live_mode, test_key: a!.test_key,
    })),
    ...(ctx.codes.length > shown.length ? { not_shown: ctx.codes.length - shown.length } : {}),
  };
}

async function listRecentRequests(ctx: ToolContext, input: { only_errors?: boolean; limit?: number }) {
  const r = await readApiLog({ merchantCodes: ctx.codes, full: true, status: input.only_errors ? "error" : null, limit: clampLimit(input.limit) });
  const several = ctx.codes.length > 1;
  return {
    count: r.length,
    requests: r.map((x) => ({
      ...(several ? { account: accountOf(ctx, x.merchant_id) } : {}),
      request_id: x.request_id, at: iso(x.created_at), endpoint: x.endpoint, http_status: x.http_status,
      error_code: x.error_code, livemode: x.livemode,
      sent: requestSummary(x.request_body as Record<string, unknown>), answer: answerSummary(x.response_body as Record<string, unknown>),
    })),
  };
}

async function checkSignature(ctx: ToolContext, input: { request_id?: string }) {
  const id = String(input.request_id ?? "").trim();
  const row = (await rows<{ merchant_id: string; endpoint: string; http_status: number; request_body: Record<string, unknown> | null; livemode: boolean | null }>("audit", `
    SELECT merchant_id, endpoint, http_status, request_body, livemode FROM api_request_log WHERE request_id = $1 AND merchant_id = ANY($2::text[]) LIMIT 1
  `, [id, ctx.codes]).catch(() => []))[0];
  if (!row) return { error: "No request with that request_id for this account in the log." };
  if (!/\/order$|\/api\/pay$/.test(row.endpoint)) return { error: `Only order requests can be checked; this was ${row.endpoint}.` };
  const b = row.request_body ?? {};
  const hint = parseHashHint(b.hash);
  if (!hint) return { error: "The request carried no usable hash." };
  const mode = keyMode(b.key) ?? (row.livemode === false ? "test" : "live");
  const [creds, other] = await Promise.all([getCheckoutCreds(row.merchant_id, mode === "live"), getCheckoutCreds(row.merchant_id, mode !== "live")]);
  if (!creds) return { error: `This account has no ${mode} key, so the request could not have been signed with it.` };
  const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
  const fields: OrderFields = { txnid: str(b.txnid) ?? "", amount: str(b.amount) ?? "", productinfo: str(b.productinfo), firstname: str(b.firstname), email: str(b.email) };
  return { request_id: id, key_mode: mode, http_status: row.http_status, ...diagnoseOrderSignature(fields, hint, creds, other) };
}

async function findOrder(ctx: ToolContext, input: { reference?: string }) {
  const scope = { staff: false, codes: ctx.codes };
  const ref = String(input.reference ?? "").trim();
  const hits = await searchOrders(ref, scope);
  if (!hits.length) return { found: false, searched_for: ref };
  const exact = hits.find((h) => h.reference === ref || h.order_id === ref || h.id === ref || h.rrn === ref) ?? hits[0];
  const t = await orderTimeline(exact.id, scope);
  if (!t) return { found: false, searched_for: ref };
  return {
    found: true, other_matches: hits.length - 1,
    ...(ctx.codes.length > 1 ? { account: accountOf(ctx, exact.merchant_id) } : {}),
    order: {
      order_id: t.order.order_id, txnid: t.order.reference, status: t.order.status, amount_rupees: t.order.amount,
      flow: t.order.flow, livemode: t.order.livemode, created_at: ist(t.order.created_at), expires_at: ist(t.order.expires_at),
      paid_at: ist(t.order.paid_at), previous_status: t.order.previous_status, rrn: t.order.rrn, rrn_made_up_by_katana: t.order.rrn_is_synthetic,
      callback_url_for_this_order: t.order.callback_url, api_version: t.order.api_version,
    },
    status_changes: t.steps.map((s) => ({ at: ist(s.at), from: s.from, to: s.to, what_happened: s.label })),
    webhook_deliveries: t.deliveries.map((d) => ({
      event: d.event, format: d.version, state: d.status, target_url: d.target_url, next_retry_at: ist(d.next_attempt_at),
      attempts: d.attempts.map((a) => ({ n: a.attempt_no, at: ist(a.sent_at), their_http_status: a.http_status, error: a.error })),
    })),
  };
}

async function listWebhookDeliveries(ctx: ToolContext, input: { limit?: number }) {
  const d = await readDeliveries("merchant_id = ANY($1::text[])", [ctx.codes], false, clampLimit(input.limit));
  return {
    count: d.length,
    deliveries: d.map((x) => ({
      event: x.event, format: x.version, state: x.status, target_url: x.target_url, created_at: ist(x.created_at), next_retry_at: ist(x.next_attempt_at),
      attempts: x.attempts.map((a) => ({ n: a.attempt_no, at: ist(a.sent_at), their_http_status: a.http_status, error: a.error })),
    })),
  };
}

async function listRecentPayouts(ctx: ToolContext, input: { limit?: number }) {
  const r = await rows<any>("fifo", `
    SELECT ${PAYOUT_VIEW_COLS}, merchant_id AS _code FROM fifo_orders WHERE merchant_id = ANY($1::text[]) AND direction = 'PAYOUT' ORDER BY created_at DESC LIMIT $2
  `, [ctx.codes, clampLimit(input.limit)]);
  const several = ctx.codes.length > 1;
  return {
    count: r.length,
    payouts: r.map((x) => ({
      ...(several ? { account: accountOf(ctx, x._code) } : {}),
      ...((p) => ({ ...p, created_at: ist(p.created_at), completed_at: ist(p.completed_at) }))(payoutView(x)),
    })),
  };
}

/** "2026-10-03 14:25" read as India time; an ISO time with a zone as given. */
export function parseIstTime(v: unknown): Date | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  const d = m ? new Date(`${m[1]}T${m[2].padStart(2, "0")}:${m[3]}:${m[4] ?? "00"}+05:30`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** What happened to money Katana saw arrive, in a merchant's words. */
const CREDIT_OUTCOME: Record<string, string> = {
  CONFIRMED: "received and matched to an order (the order was marked paid)",
  UNMATCHED: "received, but not matched to any order",
  AMBIGUOUS: "received, but more than one order could fit; waiting for Katana to check it",
};

const MIN = 60_000;

async function findPayment(ctx: ToolContext, input: { utr?: string | null; amount_rupees?: number | null; paid_at?: string | null; paid_to_upi_id?: string | null }) {
  const utr = String(input.utr ?? "").replace(/\s+/g, "") || null;
  const amount = Number(input.amount_rupees) > 0 ? Math.round(Number(input.amount_rupees) * 100) / 100 : null;
  if (!utr && !amount) return { error: "Need the UTR or the amount to look for a payment." };
  const at = parseIstTime(input.paid_at);
  // Without a time, the last three days.
  const from = at ? new Date(at.getTime() - 45 * MIN) : new Date(Date.now() - 3 * 24 * 60 * MIN);
  const to = at ? new Date(at.getTime() + 45 * MIN) : new Date();
  const several = ctx.codes.length > 1;

  // The same trace as the portals' search (lib/payment-search): orders by bank reference, or the
  // same amount made shortly before the payment; money seen arriving, tagged with these bankers.
  const { credits, orders } = await traceRows(ctx.codes, {
    utr, amount, from, to, orderFrom: new Date(from.getTime() - 30 * MIN), orderTo: at ? new Date(at.getTime() + 15 * MIN) : to,
  });
  const orderView = (o: any) => ({
    ...(several ? { account: accountOf(ctx, o.merchant_id) } : {}),
    order_id: v2OrderId(o.id), txnid: o.order_id, status: v2Status(o.status), amount_rupees: o.amount,
    flow: o.channel_type ?? null, livemode: o.livemode !== false, created_at: ist(o.created_at), last_change_at: ist(o.updated_at),
    bank_reference: v2Status(o.status) === "SUCCESS" ? o.rrn || null : null,
  });
  const byId = new Map(orders.map((o) => [o.id, o]));

  let upi: Record<string, unknown> = {};
  const paidTo = String(input.paid_to_upi_id ?? "").trim().toLowerCase();
  if (paidTo) {
    const mine = (await settlementVpasFor(ctx.codes).catch(() => [] as string[])).map((v) => v.trim().toLowerCase());
    upi = {
      upi_id_on_screenshot_is_one_of_this_merchants_upi_ids: mine.includes(paidTo),
      upi_id_note: "On the P2P flow the customer should pay one of the merchant's own UPI IDs. On the Intent flow the customer pays the payment processor, so a different UPI ID is normal there.",
    };
  }

  return {
    searched: { utr, amount_rupees: amount, around: at ? ist(at) : "the last 3 days" },
    money_received: credits.map((c) => {
      const matched = c.matched_order_id ? byId.get(c.matched_order_id) : null;
      return {
        ...(several ? { account: accountOf(ctx, c.merchant_id) } : {}),
        amount_rupees: c.amount, utr: c.utr, paid_at: ist(c.event_time ?? c.created_at), katana_saw_it_at: ist(c.created_at),
        livemode: c.livemode !== false, what_happened: CREDIT_OUTCOME[c.outcome] ?? "received",
        matched_order: matched ? { order_id: v2OrderId(matched.id), txnid: matched.order_id, status: v2Status(matched.status) } : null,
      };
    }),
    orders: orders.map(orderView),
    ...upi,
  };
}

const HANDLERS: Record<string, (ctx: ToolContext, input: any) => Promise<unknown>> = {
  get_account_setup: getAccountSetup,
  list_recent_requests: listRecentRequests,
  check_signature: checkSignature,
  find_order: findOrder,
  find_payment: findPayment,
  list_webhook_deliveries: listWebhookDeliveries,
  list_recent_payouts: listRecentPayouts,
};

/** Run one tool for the bot. Never throws: a failure is returned as an error result. */
export async function runSupportTool(name: string, input: unknown, ctx: ToolContext): Promise<{ text: string; isError: boolean }> {
  const handler = HANDLERS[name];
  if (!handler) return { text: JSON.stringify({ error: `unknown tool ${name}` }), isError: true };
  if (!ctx.codes.length) return { text: JSON.stringify({ error: "no account is linked to this login yet" }), isError: true };
  try {
    const out = await handler(ctx, (input && typeof input === "object" ? input : {}) as Record<string, unknown>);
    let text = stripGatewayNames(JSON.stringify(out), "payment processor");
    if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}… (cut: ask for fewer items)`;
    return { text, isError: false };
  } catch (err) {
    return { text: stripGatewayNames(JSON.stringify({ error: `lookup failed: ${(err as Error).message.slice(0, 200)}` }), "payment processor"), isError: true };
  }
}
