// "Activate live mode" — PHASE 2 of test mode.
//
// A banker integrates with its TEST pair from day one. Taking REAL payments needs live mode
// ACTIVATED: an automatic checklist goes green, the banker requests activation, and a Super Admin
// approves it. Until then nothing live can be created for that banker:
//   - no live Checkout Key + Salt (issueCheckoutCreds) and no live TSP secret (rotateWebhookSecret)
//   - no live order, from a key or from the dashboard (createKatanaOrder, /api/pay, /api/checkout)
//
// GRANDFATHERED. A banker that already holds a live credential or has ever had a live order was
// taking real payments before this existed. The first time such a banker is checked it is recorded
// ACTIVATED (grandfathered = true), so nothing already running breaks. The evidence lives in two
// other databases, which is why this happens here and not in the migration.
//
// Storage: merchantservice_db.merchant_live_activation (merchant migration 0009), keyed by
// merchant_code — what keys, orders and credits are stamped with. Deliberately imports nothing but
// lib/pg and the modules that themselves import only lib/pg (the flow and services stores): the
// key and webhook helpers import this module to gate themselves.

import { rows } from "@/lib/pg";
import { wormAppend } from "@/lib/worm";
import { getEffectiveFlow } from "@/lib/payin-flow-store";
import { getProviderServices } from "@/lib/merchant-services-store";
import { flowReadiness } from "@/lib/payin-flow-api";
import { liveChecklistNeeds, liveSetupMissing, setupItems } from "@/lib/merchant-services";

export type ActivationStatus = "NOT_REQUESTED" | "REQUESTED" | "ACTIVATED" | "REJECTED";
export const ACTIVATION_STATUSES: ActivationStatus[] = ["NOT_REQUESTED", "REQUESTED", "ACTIVATED", "REJECTED"];

export class LiveModeNotActivatedError extends Error {
  constructor(readonly merchantCode: string) {
    super("live mode is not activated for this account — complete the Activate live mode checklist in the dashboard");
    this.name = "LiveModeNotActivatedError";
  }
}

export class ActivationError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = "ActivationError";
  }
}

/** Shortest note a Super Admin may switch live mode on with while its setup is incomplete. */
export const SETUP_OVERRIDE_NOTE_MIN = 5;

/** For route catch blocks: the HTTP status + body for an activation error, or null for any other. */
export function activationErrorResponse(err: unknown): { status: number; body: { error: string; code?: string } } | null {
  if (err instanceof LiveModeNotActivatedError)
    return { status: 403, body: { error: err.message, code: "LIVE_MODE_NOT_ACTIVATED" } };
  if (err instanceof ActivationError) return { status: err.status, body: { error: err.message, ...(err.code ? { code: err.code } : {}) } };
  return null;
}

interface ActivationRow {
  merchant_code: string;
  status: ActivationStatus;
  grandfathered: boolean;
  requested_at: string | null;
  requested_by: string | null;
  decided_at: string | null;
  decided_by: string | null;
  reason: string | null;
}

const COLS = `merchant_code, status, grandfathered, requested_at::text, requested_by, decided_at::text, decided_by, reason`;

// Activation is never revoked from the dashboard, and this check runs on every live order — so an
// ACTIVATED answer is reused for a minute. A decision clears the entry for its banker.
const activatedCache = new Map<string, number>();
const CACHE_MS = 60_000;

async function readRow(code: string): Promise<ActivationRow | null> {
  const r = await rows<ActivationRow>("merchant", `SELECT ${COLS} FROM merchant_live_activation WHERE merchant_code = $1`, [code]);
  return r[0] ?? null;
}

/** Evidence the banker was taking live payments before activation existed. */
async function wasAlreadyLive(code: string): Promise<boolean> {
  const found = await Promise.all([
    rows("checkout", `SELECT 1 FROM merchant_checkout_keys WHERE merchant_code = $1 AND livemode = true LIMIT 1`, [code]),
    rows("checkout", `
      SELECT 1 FROM credential_vault
       WHERE kind = 'webhook_secret' AND owner_type = 'merchant' AND owner_id = $1
         AND label = 'tsp_callback_secret' AND enabled = true LIMIT 1`, [code]),
    rows("vendorGateway", `SELECT 1 FROM vendor_payin_orders WHERE merchant_id = $1 AND livemode = true LIMIT 1`, [code]),
    rows("checkout", `SELECT 1 FROM checkout_orders WHERE merchant_id = $1 AND livemode = true LIMIT 1`, [code]),
  ]);
  return found.some((r) => r.length > 0);
}

/** The stored row, grandfathering a banker that was already live the first time it is seen. */
async function currentRow(code: string): Promise<ActivationRow | null> {
  const row = await readRow(code);
  if (row) return row;
  if (!(await wasAlreadyLive(code))) return null;
  const ins = await rows<ActivationRow>("merchant", `
    INSERT INTO merchant_live_activation (merchant_code, status, grandfathered, decided_at, decided_by, reason)
    VALUES ($1, 'ACTIVATED', true, now(), 'system', 'already taking live payments before live mode activation existed')
    ON CONFLICT (merchant_code) DO NOTHING
    RETURNING ${COLS}
  `, [code]);
  return ins[0] ?? (await readRow(code));
}

const MISSING_TABLE = /relation "merchant_live_activation" does not exist/;

export async function isLiveActivated(code: string): Promise<boolean> {
  const at = activatedCache.get(code);
  if (at && Date.now() - at < CACHE_MS) return true;
  let row: ActivationRow | null;
  try {
    row = await currentRow(code);
  } catch (err) {
    // Code deployed before merchant migration 0009: the gate is not switched on yet, so it must not
    // stop payments that were flowing. Every other error propagates — a live order should fail
    // loudly rather than skip the check.
    if (MISSING_TABLE.test((err as Error).message)) return true;
    throw err;
  }
  const ok = row?.status === "ACTIVATED";
  if (ok) activatedCache.set(code, Date.now());
  return ok;
}

/** Throws LiveModeNotActivatedError unless the banker may create live keys and live orders. */
export async function assertLiveActivated(code: string): Promise<void> {
  if (!(await isLiveActivated(code))) throw new LiveModeNotActivatedError(code);
}

/** How many successful test payments the checklist asks for (LIVE_MIN_TEST_PAYMENTS, default 1). */
export function minTestPayments(): number {
  const n = Number(process.env.LIVE_MIN_TEST_PAYMENTS ?? 1);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * LIVE_AUTO_ACTIVATE=1: a request with a complete checklist is approved at once, by the system.
 * The checklist's first item is "onboarding approved", which only a Super Admin can make true,
 * so a person has still approved the account; what this removes is the second approval.
 */
export const autoActivate = () => process.env.LIVE_AUTO_ACTIVATE === "1";

export interface ChecklistItem {
  key: "onboarding" | "settlement_vpa" | "payin_gateway" | "webhook_url" | "test_payment" | "test_payout";
  label: string;
  done: boolean;
  hint: string;
}

// The checklist asks for what the banker's merchant was onboarded for (lib/merchant-services):
// a P2P banker its settlement UPI ID, an Intent banker its pay-in gateway, a pay-out only banker
// a test payout instead of a test payment. A banker nobody chose for keeps the checklist it
// always had.
async function checklist(code: string): Promise<ChecklistItem[]> {
  const flow = await getEffectiveFlow(code).catch(() => null);
  const services = await getProviderServices(flow?.providerId).catch(() => "UNSET" as const);
  const needs = liveChecklistNeeds(services, flow ? { flow: flow.flow, active: flow.active } : { flow: "UNSET", active: null });
  // A lookup that fails reads as "not done": the checklist may under-report, never over-report.
  const [merchant, cfg, testPayin, testCheckout, ready, testPayout] = await Promise.all([
    rows<{ stage: string; webhook_url: string | null }>("merchant",
      `SELECT stage, webhook_url FROM merchants WHERE merchant_code = $1`, [code]).catch(() => []),
    rows<{ vpa: string | null; vpas: unknown }>("merchant",
      `SELECT katana_pay->>'settlement_vpa' AS vpa, katana_pay->'settlement_vpas' AS vpas
         FROM merchant_payment_config WHERE merchant_code = $1`, [code]).catch(() => []),
    rows<{ n: number }>("vendorGateway", `
      SELECT COUNT(*)::int AS n FROM vendor_payin_orders
       WHERE merchant_id = $1 AND livemode = false AND status IN ('SUCCESS', 'SUCCEEDED')`, [code]).catch(() => []),
    rows<{ n: number }>("checkout", `
      SELECT COUNT(*)::int AS n FROM checkout_orders WHERE merchant_id = $1 AND livemode = false AND status = 'SUCCESS'`, [code]).catch(() => []),
    needs.payinGateway || needs.settlementVpa ? flowReadiness([code]).catch(() => null) : null,
    needs.testPayout
      ? rows<{ n: number }>("fifo", `
          SELECT COUNT(*)::int AS n FROM fifo_orders
           WHERE merchant_id = $1 AND direction = 'PAYOUT' AND livemode = false AND status IN ('COMPLETED', 'SETTLED')`, [code]).catch(() => [])
      : [],
  ]);
  const need = minTestPayments();
  const tests = (testPayin[0]?.n ?? 0) + (testCheckout[0]?.n ?? 0);
  const m = merchant[0];
  const c = cfg[0];
  const extraVpas = Array.isArray(c?.vpas) && c.vpas.some((v) => typeof v === "string" && v.trim());

  const items: (ChecklistItem | false)[] = [
    {
      key: "onboarding", label: "Onboarding approved", done: m?.stage === "LIVE",
      hint: "Katana finishes KYB, screening and bank verification, then approves the account.",
    },
    needs.settlementVpa && {
      // A P2P processor account (lib/pg-catalog gatewayAccountChannel) takes P2P payments in its place.
      key: "settlement_vpa", label: "Settlement UPI ID saved", done: !!c?.vpa?.trim() || extraVpas || !!ready?.get(code)?.p2p,
      hint: "The UPI ID your live payments are paid to. Your Katana account manager sets it.",
    },
    needs.payinGateway && {
      key: "payin_gateway", label: "Payment processor connected", done: !!ready?.get(code)?.intent,
      hint: "Your live payments are taken by a payment processor. Your Katana account manager connects it.",
    },
    {
      key: "webhook_url", label: "Webhook URL set", done: !!m?.webhook_url?.trim(),
      hint: "Where Katana posts payment results for your server. Set it under Return & webhook URLs.",
    },
    needs.testPayment && {
      key: "test_payment", done: tests >= need,
      label: need === 1 ? "A test payment succeeded" : `${need} test payments succeeded (${Math.min(tests, need)} so far)`,
      hint: "Create an order with your test key and open its payment page: tap Simulate success, or send an amount ending in .99.",
    },
    needs.testPayout && {
      key: "test_payout", label: "A test payout succeeded", done: (testPayout[0]?.n ?? 0) > 0,
      hint: "Send a payout with your test key: an amount ending in .99 succeeds at once. No money moves.",
    },
  ];
  return items.filter((i): i is ChecklistItem => !!i);
}

/**
 * What the banker still needs before it can take live money: the go-live SETUP gate's rule
 * (lib/merchant-services setupItems), in plain words. A payout gateway is optional, so it is
 * never asked for here. A failed lookup propagates: live mode is not switched on blind.
 */
async function setupMissing(code: string): Promise<string[]> {
  const flow = await getEffectiveFlow(code);
  const [services, ready] = await Promise.all([getProviderServices(flow.providerId), flowReadiness([code])]);
  const r = ready.get(code);
  return liveSetupMissing(setupItems(services, { flow: flow.flow, active: flow.active },
    { upiId: !!r?.p2p, payinGateway: !!r?.intent, payoutGateway: true }));
}

export interface ActivationState {
  merchant_code: string;
  status: ActivationStatus;
  grandfathered: boolean;
  requested_at: string | null;
  requested_by: string | null;
  decided_at: string | null;
  decided_by: string | null;
  reason: string | null;
  checklist: ChecklistItem[];
  /** Every checklist item is done — the banker may request activation. */
  ready: boolean;
  /**
   * What the banker needs before it can take live money (plain words); empty when nothing.
   * Live mode is refused while this is not empty, unless a Super Admin overrides with a note.
   */
  setup_missing: string[];
}

export async function activationState(code: string): Promise<ActivationState> {
  const [row, items, missing] = await Promise.all([currentRow(code), checklist(code), setupMissing(code)]);
  return {
    merchant_code: code,
    status: row?.status ?? "NOT_REQUESTED",
    grandfathered: row?.grandfathered ?? false,
    requested_at: row?.requested_at ?? null,
    requested_by: row?.requested_by ?? null,
    decided_at: row?.decided_at ?? null,
    decided_by: row?.decided_by ?? null,
    reason: row?.reason ?? null,
    checklist: items,
    ready: items.every((i) => i.done),
    setup_missing: missing,
  };
}

async function logActivity(code: string, action: string, actor: string, payload: Record<string, unknown>) {
  // merchant_activity is keyed by the merchants row's uuid; a banker without one has no log.
  await rows("merchant", `
    INSERT INTO merchant_activity (merchant_id, action, actor, payload)
    SELECT id, $2, $3, $4::jsonb FROM merchants WHERE merchant_code = $1
  `, [code, action, actor, JSON.stringify(payload)]).catch(() => {});
}

/** The banker asks Katana to turn on live mode. Only once the checklist is complete. */
export async function requestActivation(code: string, actor: string): Promise<ActivationState> {
  const s = await activationState(code);
  if (s.status === "ACTIVATED") throw new ActivationError(409, "live mode is already active");
  if (s.status === "REQUESTED") throw new ActivationError(409, "activation already requested — Katana is reviewing it");
  if (!s.ready) {
    const missing = s.checklist.filter((i) => !i.done).map((i) => i.label.toLowerCase());
    throw new ActivationError(400, `finish the checklist first: ${missing.join(", ")}`);
  }
  await rows("merchant", `
    INSERT INTO merchant_live_activation (merchant_code, status, requested_at, requested_by)
    VALUES ($1, 'REQUESTED', now(), $2)
    ON CONFLICT (merchant_code) DO UPDATE
       SET status = 'REQUESTED', requested_at = now(), requested_by = $2,
           decided_at = NULL, decided_by = NULL, reason = NULL, updated_at = now()
     WHERE merchant_live_activation.status IN ('NOT_REQUESTED', 'REJECTED')
  `, [code, actor]);
  await logActivity(code, "LIVE_ACTIVATION_REQUESTED", actor, {});
  // Approved at once only when it can really take money; otherwise it waits for a person.
  if (autoActivate() && !s.setup_missing.length)
    return decideActivation(code, "APPROVE", "system:auto", "checklist complete; approved automatically");
  return activationState(code);
}

/**
 * A Super Admin approves or rejects. Approval may override an incomplete checklist (an operator can
 * know something the checks cannot see); the log records whether it did. It is refused while the
 * banker cannot take live money (`setup_missing`, 409 SETUP_INCOMPLETE) unless `overrideSetup` is
 * sent with a note of at least SETUP_OVERRIDE_NOTE_MIN characters, which is recorded.
 */
export async function decideActivation(
  code: string, decision: "APPROVE" | "REJECT", actor: string, reason?: string | null,
  opts: { overrideSetup?: boolean; actorId?: string } = {},
): Promise<ActivationState> {
  const s = await activationState(code);
  if (s.status === "ACTIVATED") throw new ActivationError(409, "live mode is already active");
  const why = reason?.trim() || null;
  if (decision === "REJECT" && !why) throw new ActivationError(400, "give a reason so the banker knows what to fix");
  const overriding = decision === "APPROVE" && s.setup_missing.length > 0;
  if (overriding && !opts.overrideSetup)
    throw new ActivationError(409, `This account can't take live payments yet: ${s.setup_missing.join("; ")}.`, "SETUP_INCOMPLETE");
  if (overriding && (why?.length ?? 0) < SETUP_OVERRIDE_NOTE_MIN)
    throw new ActivationError(400, `Say why live mode should be switched on anyway: at least ${SETUP_OVERRIDE_NOTE_MIN} characters.`, "OVERRIDE_NOTE_REQUIRED");
  const status: ActivationStatus = decision === "APPROVE" ? "ACTIVATED" : "REJECTED";
  await rows("merchant", `
    INSERT INTO merchant_live_activation (merchant_code, status, decided_at, decided_by, reason)
    VALUES ($1, $2, now(), $3, $4)
    ON CONFLICT (merchant_code) DO UPDATE
       SET status = $2, decided_at = now(), decided_by = $3, reason = $4, updated_at = now()
  `, [code, status, actor, why]);
  activatedCache.delete(code);
  await logActivity(code, `LIVE_ACTIVATION_${status}`, actor, { reason: why, checklist_complete: s.ready, previous: s.status,
    ...(overriding ? { setup_override: true, setup_missing: s.setup_missing } : {}) });
  // Recorded like an onboarding gate override (api/merchants/[id]/advance).
  if (overriding)
    await wormAppend({
      actorId: opts.actorId, actorEmail: actor, action: "merchant.live_activation.setup_override",
      resourceType: "merchant", resourceId: code, after: { setup_missing: s.setup_missing }, notes: why ?? "",
    }).catch(() => {});
  return activationState(code);
}

export interface ActivationListRow extends ActivationRow {
  merchant_id: string | null;
  name: string | null;
}

/** The admin queue. `status` null lists every banker that has an activation record. */
export async function listActivations(status: ActivationStatus | null): Promise<ActivationListRow[]> {
  return rows<ActivationListRow>("merchant", `
    SELECT a.merchant_code, a.status, a.grandfathered, a.requested_at::text, a.requested_by,
           a.decided_at::text, a.decided_by, a.reason,
           m.id::text AS merchant_id, COALESCE(NULLIF(m.brand_name, ''), m.legal_name) AS name
      FROM merchant_live_activation a
      LEFT JOIN merchants m ON m.merchant_code = a.merchant_code
     WHERE ($1::text IS NULL OR a.status = $1)
     ORDER BY COALESCE(a.requested_at, a.decided_at, a.created_at) DESC
     LIMIT 500
  `, [status]);
}
