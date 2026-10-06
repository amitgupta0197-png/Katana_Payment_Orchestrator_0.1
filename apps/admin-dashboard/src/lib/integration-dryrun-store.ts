// "Test my integration": a pasted order request checked the way the order API checks it
// (lib/katana-order-api), with the same functions, WITHOUT creating an order or asking any gateway.
// Rules and the merchant's wording are in lib/integration-dryrun.
//
// Scope: the Key must belong to one of the logged-in user's own bankers (lib/portal-scope). Any
// other key, including a real key of another merchant, is answered exactly like an unknown key.
// The Salt is never shown; a wrong hash is explained from which usual mistake reproduces it
// (lib/support-bot/signature).

import { rows } from "@/lib/pg";
import type { Session } from "@/lib/auth";
import { inScope, portalScope } from "@/lib/portal-scope";
import { ORDER_REQUEST_SCHEMA } from "@/lib/katana-order-api";
import { describeOrderRequestError } from "@/lib/order-request-errors";
import { getCheckoutCreds, resolveCheckoutKey, verifyCheckoutSignature } from "@/lib/merchant-checkout";
import { diagnoseOrderSignature } from "@/lib/support-bot/signature";
import { bankerCheckFacts } from "@/lib/banker-check-store";
import { checkBanker } from "@/lib/banker-check";
import { decideOrderFlow } from "@/lib/payin-flow";
import {
  amountProblems, BLOCKS_TEST_ORDERS, dryRunResult, parseRequestText, setupProblem, SIGNATURE_FIX,
  type DryRunProblem, type DryRunResult,
} from "@/lib/integration-dryrun";

const BASE = () => (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");

// ── Rate limit: per banker (or per login before the Key is known), per hour, per process ─────

export const DRYRUN_PER_HOUR = 30;
const hits = new Map<string, number[]>();
/** True when one more try is allowed for `who` this hour; it is then counted. */
export function takeTry(who: string, perHour = DRYRUN_PER_HOUR, now = Date.now()): boolean {
  const recent = (hits.get(who) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= perHour) { hits.set(who, recent); return false; }
  recent.push(now); hits.set(who, recent);
  return true;
}

const ENDPOINT_FOR = { P2P: "/api/v1/p2p/order", INTENT: "/api/v1/intent/order" } as const;

export async function dryRunOrder(s: Session, text: string, picked: "test" | "live" | null): Promise<DryRunResult | { limited: true }> {
  const p = parseRequestText(text);
  const problems: DryRunProblem[] = [], notes: string[] = [], passed: string[] = [];
  const out = (banker: string | null, livemode: boolean | null) =>
    dryRunResult({ banker, livemode, endpoint: p.endpoint, problems, notes, passed });

  if (!takeTry(`login:${s.user_id ?? s.email}`, DRYRUN_PER_HOUR * 3)) return { limited: true };
  if (p.error || !p.body) { problems.push({ code: "INVALID_REQUEST", title: p.error ?? "Nothing to check.", fix: "Paste the JSON body, or the whole curl command from Postman." }); return out(null, null); }

  if (!Object.values(ENDPOINT_FOR).includes(p.endpoint as never) && p.endpoint !== "/api/v1/katana-pay/order")
    problems.push({ code: "WRONG_ENDPOINT", title: `${p.endpoint} isn't Katana's order address.`, fix: `POST to ${BASE()}/api/v1/katana-pay/order (or the P2P / Intent order address).` });
  if (p.host && p.host !== new URL(BASE()).host && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(p.host))
    notes.push(`You're sending to ${p.host}. Katana's address is ${BASE()}.`);

  const parsed = ORDER_REQUEST_SCHEMA.safeParse(p.body);
  if (!parsed.success) {
    const e = describeOrderRequestError(p.body, parsed.error);
    for (const f of e.missing) problems.push({ code: "INVALID_REQUEST", title: `${f} is missing.`, fix: `Add "${f}" to the body.` });
    for (const f of e.invalid) problems.push({ code: "INVALID_REQUEST", title: `${f.field} isn't valid: ${f.problem}.`, fix: `Fix "${f.field}".` });
    notes.push(...e.hints.map((h) => h[0].toUpperCase() + h.slice(1) + "."));
    if (e.missing.includes("key") || typeof p.body.key !== "string") return out(null, null);
  } else passed.push("Every required field is there.");

  // The Key: one of this login's own bankers, or "not found" (never say whose it is).
  const key = String(p.body.key ?? "");
  const resolved = await resolveCheckoutKey(key).catch(() => null);
  const scope = await portalScope(s);
  const creds = resolved && inScope(scope, resolved.merchantCode) ? await getCheckoutCreds(resolved.merchantCode, resolved.livemode).catch(() => null) : null;
  if (!resolved || !creds || creds.key !== key) {
    problems.push({ code: "INVALID_KEY", title: "This key isn't one of your keys, or it was replaced.", fix: "Copy the Key again from Key + Salt in your portal." });
    return out(null, null);
  }
  const { merchantCode: code, livemode } = resolved;
  if (!takeTry(`banker:${code}`)) return { limited: true };
  passed.push(`The key is your ${livemode ? "live" : "test"} key for ${code}.`);
  if (picked && (picked === "live") !== livemode)
    notes.push(`You picked ${picked}, but this is a ${livemode ? "live" : "test"} key. The key decides the mode.`);
  if (!parsed.success) return out(code, livemode);

  // The signature, checked with the order API's own function.
  const b = parsed.data;
  const amountStr = typeof b.amount === "number" ? b.amount.toString() : b.amount;
  const fields = { txnid: b.txnid, amount: amountStr, productinfo: b.productinfo, firstname: b.firstname, email: b.email };
  if (verifyCheckoutSignature(creds, { txnId: b.txnid, amount: amountStr, productinfo: b.productinfo, firstname: b.firstname, email: b.email }, b.hash)) {
    passed.push("The hash is right.");
  } else {
    const other = await getCheckoutCreds(code, !livemode).catch(() => null);
    const d = diagnoseOrderSignature(fields, { prefix: b.hash.slice(0, 4), length: b.hash.length }, creds, other);
    problems.push({
      code: "SIGNATURE_MISMATCH", title: "The hash doesn't match this request.",
      fix: `${SIGNATURE_FIX[d.verdict]} The string to sign (${d.scheme}) is: ${d.should_sign}`,
    });
  }

  // Everything else the order path checks, from "Check this banker" (no order is made).
  const facts = await bankerCheckFacts(code);
  if (!facts) { problems.push({ code: "INVALID_KEY", title: "This account can't be found.", fix: "Contact Katana support." }); return out(code, livemode); }
  const seen = new Set<string>();
  for (const x of checkBanker(facts).blockers) {
    if (!livemode && !BLOCKS_TEST_ORDERS.has(x.key)) continue;
    const m = setupProblem(x.key);
    if (m && !seen.has(m.code)) { seen.add(m.code); problems.push(m); }
  }

  const decision = decideOrderFlow(facts.flow, p.flow);
  if (!decision.ok) {
    const right = facts.flow.flow === "P2P" || facts.flow.flow === "INTENT" ? ENDPOINT_FOR[facts.flow.flow] : "/api/v1/katana-pay/order";
    problems.push(decision.code === "FLOW_NOT_ENABLED"
      ? { code: "FLOW_NOT_ENABLED", title: `This account isn't set up for ${p.flow === "P2P" ? "P2P" : "Intent"} payments.`, fix: `Use ${BASE()}${right}.` }
      : { code: "FLOW_NOT_SELECTED", title: "No payment flow is chosen for this account yet, so this address is refused.", fix: `Use ${BASE()}/api/v1/katana-pay/order, or ask Katana to choose a flow.` });
  } else passed.push(`The address matches how this account takes payments.`);

  const toGateway = livemode && facts.account?.channel === "INTENT"
    && (decision.ok ? decision.flow === "INTENT" || (decision.flow === null && !facts.upiId) : false);
  const amount = Number(amountStr);
  const amt = amountProblems(amount, livemode, {
    min: facts.limits.min, max: facts.limits.max, upiMax: facts.limits.upiMax,
    accountMin: toGateway ? facts.account?.minAmount ?? null : null,
    verifyCap: toGateway && facts.account?.golive === "VERIFYING" ? facts.account.verifyCap : null,
  });
  if (amt.length) problems.push(...amt); else passed.push("The amount is allowed.");

  // A txnid already used by this key is answered with that order, not a new one.
  const reused = (await rows<{ status: string }>("vendorGateway", `
    SELECT status FROM vendor_payin_orders
     WHERE order_id = $1 AND COALESCE(signed_by, merchant_id) = $2 AND livemode = $3 LIMIT 1`,
    [b.txnid, code, livemode]).catch(() => []))[0];
  if (reused) notes.push(`This txnid was used before (that order is ${reused.status.toLowerCase()}). Katana will send back the same order with "reused": true. Use a new txnid for a new order.`);

  if (!b.notify_url && !facts.callback.url) notes.push("No callback URL is set, so your server won't be told when it's paid. Set one under Webhooks, or send notify_url.");
  if (!livemode) notes.push("A test order pays a test UPI ID. No real money moves.");
  else if (facts.account?.checkout === "REDIRECT" && toGateway) notes.push("Live orders on this account are redirect: send the customer to pay_url.");
  else if (facts.account?.checkout === "H2H" && toGateway) notes.push("Live orders on this account carry the UPI link (upi_intent) for your own page.");

  return out(code, livemode);
}

/** What the merchant's server answered to a sample callback (lib/webhook-test), from its attempt row. */
export async function lastAttemptFor(outboxId: string): Promise<{ http_status: number | null; duration_ms: number | null; body: string | null; error: string | null } | null> {
  const r = await rows<{ http_status: number | null; duration_ms: number | null; body: string | null; error: string | null }>("notification", `
    SELECT response_status AS http_status, duration_ms, LEFT(response_body, 300) AS body, error
      FROM webhook_dispatch_attempts WHERE outbox_id = $1::uuid ORDER BY attempt_no DESC LIMIT 1`, [outboxId]).catch(() => []);
  return r[0] ?? null;
}
