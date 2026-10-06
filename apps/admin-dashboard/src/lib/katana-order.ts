// Shared Katana pay-in order creation. Used by both the cockpit test endpoint
// and the merchant-signed /api/v1/katana-pay/order endpoint so the deeplink/insert
// logic lives in one place. Idempotent on (vendor, merchant, livemode, order_id).

import { randomUUID } from "crypto";
import { rows } from "@/lib/pg";
import { buildUpiQuery, buildDeeplinks, genRrn, KATANA_TERMINAL, SANDBOX_PAYEE_VPA, type DeepLinks } from "@/lib/katana-pay";
import { sendPayinCallback } from "@/lib/merchant-callback";
import { assertLiveActivated } from "@/lib/live-activation";
import { getGatewayMid, payinProdId, payuKeySalt } from "@/lib/gateway-creds";
import { createPayuUpiIntent, PayuIntentError, type PayuIntentClient } from "@/lib/payu-intent";
import { gatewayPayinFor } from "@/lib/payin-providers";
import { payinProdEnabled, payinReturnUrl, payinWebhookUrl } from "@/lib/payin-providers/types";
import { gatewayAccountChannel, gatewayName } from "@/lib/pg-catalog";
import { classifyPayinOrder, SANDBOX_CHANNEL_ID } from "@/lib/payin-channel";
import { decideOrderFlow, type OrderFlow } from "@/lib/payin-flow";
import { getEffectiveFlow } from "@/lib/payin-flow-store";
import { allowsPayin } from "@/lib/merchant-services";
import { getProviderServices } from "@/lib/merchant-services-store";
import { checkPayinLimits, effectivePayinLimits, platformPayinLimits, PayinLimitError } from "@/lib/payin-limits";
import { getPayinLimits, getPayinUsage } from "@/lib/payin-limits-store";
import { AccountNotLiveError, assertGoLiveAllows } from "@/lib/gateway-golive";
import { insertOrderWithinLimits, pickMidForOrder, recordCreateFailure, type MidPick } from "@/lib/mid-switch-store";
import { NoMidAvailableError, type Mid } from "@/lib/mid-switch";
import { bankerOrder, passOverWords } from "@/lib/banker-switch";
import { bankersWithKey, bankerToday, logSwitchEvent, noteTaken, switchForSigner } from "@/lib/banker-switch-store";
import { LiveModeNotActivatedError } from "@/lib/live-activation";
import { raiseAlert } from "@/lib/ops-alert";
import { isExclusivePartner } from "@/lib/partner/exclusive";

export interface CreateKatanaOrderInput {
  orderId: string;
  amount: number;
  currency: string;
  channel?: string;
  customerVpa?: string | null;   // sender / payer UPI VPA
  receiverVpa?: string | null;   // single receiver VPA (legacy / convenience)
  receiverVpas?: string[];       // receiver VPA pool (20-25) for backup failover
  mode?: "QR" | "INTENT";        // QR-based vs non-QR (deeplink) presentation
  customerPhone?: string | null;
  merchantId?: string | null;
  returnUrl?: string | null;     // browser redirect target after payment (per-order)
  notifyUrl?: string | null;     // S2S status-callback target (per-order; overrides merchant default)
  livemode?: boolean;            // false = TEST order (default live); set once, never changes
  client?: PayuIntentClient | null; // paying customer's IP + user-agent — PayU requires them
  /** The flow asked for by name (the P2P or the Intent API). Absent on the general order API. */
  flow?: OrderFlow | null;
  /** The id of the request that created the order; kept on the order and in its status history. */
  requestId?: string | null;
  /** v2: the merchant's own key/value notes, kept on the order and given back when it is read. */
  metadata?: Record<string, string | number | boolean | null>;
  /** Which order API created it. Absent = v1. */
  apiVersion?: "v2";
  /** Internal: MIDs that could not create this order a moment ago (the switch tries the next one). */
  excludeMids?: string[];
  /**
   * The order was signed with a merchant's Key + Salt (the v1 and v2 order APIs): when the
   * merchant's banker switch is on, another of its bankers may take it (lib/banker-switch).
   */
  routeAcrossBankers?: boolean;
  /** Internal: the banker whose Key signed an order that `merchantId` is taking. */
  signedBy?: string | null;
  /**
   * A live test made by Katana staff from the banker page (Intent live test). Kept on the order
   * as `meta.staff_test`; the banker's server is not sent a callback for it (lib/merchant-callback).
   */
  staffTest?: { by: string } | null;
  /**
   * A partner's order (lib/partner): the partner and the sub-merchant it is for, kept on the order
   * (partner_id, partner_sub_merchant_id, meta.partner). The partner's bankers take nothing else
   * when it is exclusive, and the partner's own gateway is never used for its orders.
   */
  partner?: PartnerOrderInput | null;
}

export interface PartnerOrderInput {
  partnerId: string;
  subMerchantId: string;
  subCode: string;
  externalId: string;
  /** The connector that is the partner's own company (e.g. PAYATOM): its accounts never take a partner order. */
  ownGateway: string | null;
}

/**
 * Set on meta.gateway when a payment gateway (PayU, or Razorpay / Cashfree / PhonePe / Paytm
 * through lib/payin-providers) issued the order's UPI intent. Such an order is confirmed by that
 * gateway only; the bank-credit matcher leaves it alone.
 */
/** A live order this merchant's setup can't take (no gateway page, no receiver UPI ID). Routes answer 409. */
export class PayinSetupError extends Error {
  readonly status = 409;
}

/** The merchant's selected pay-in flow (lib/payin-flow) does not allow this order. */
export class PayinFlowError extends PayinSetupError {
  constructor(message: string, readonly code: "FLOW_NOT_SELECTED" | "FLOW_NOT_ENABLED" | "FLOW_NOT_READY") { super(message); }
}

interface PayuGatewayMeta {
  provider: string;
  txnid: string;                 // the txnid we sent PayU (also vendor_txn_id)
  payment_id: string | null;
  env: string;
  payee_vpa: string | null;      // PayU's collection VPA from the intent
  /** PayU Client ID mode: how Katana signs in, and the PayU payment page the customer pays on. */
  auth?: "client_credentials";
  checkout_url?: string;
  /** The processor's own payment page for an order paid by UPI link (PayAtom quasi intent): a fallback, reached through /pay/{id}/go. */
  page_url?: string;
}

// Build the receiver-VPA pool with per-VPA health. The first READY VPA is active;
// on failure ops/merchant advances to the next so the order can still succeed.
export function buildVpaPool(input: CreateKatanaOrderInput): { pool: { vpa: string; status: string }[]; active: string | null } {
  const list = (input.receiverVpas?.length ? input.receiverVpas : (input.receiverVpa ? [input.receiverVpa] : []))
    .map((v) => v.trim()).filter(Boolean);
  const pool = list.map((vpa, i) => ({ vpa, status: i === 0 ? "ACTIVE" : "READY" }));
  return { pool, active: pool[0]?.vpa ?? null };
}

export interface CreateKatanaOrderResult {
  order: any;
  deeplinks: DeepLinks;
  upiIntent: string;
  reused: boolean; // true when an order with this (vendor, order_id) already existed
  /** Set when the customer pays on the gateway's own page (PayU Client ID, RubyVault, iSmartPay). */
  checkoutUrl?: string | null;
  /** The gateway whose page that is (PAYU, RUBYVAULT, ISMARTPAY). */
  checkoutGateway?: string | null;
  /** The banker the order belongs to (another of the merchant's bankers when the banker switch moved it). */
  banker?: string | null;
}

/** The txnid is already an order on the banker the switch offered this one to (signed by another Key). */
export class OrderRefTakenError extends Error {
  readonly status = 409;
  readonly code = "TXNID_IN_USE";
  constructor(orderId: string) { super(`txnid ${orderId} is already used by another order`); }
}

function shortId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

// Risk threshold (major units). Orders >= this are held for manual review.
export const HIGH_AMOUNT_HOLD = Number(process.env.HIGH_AMOUNT_HOLD ?? 50000);

export class MerchantBlockedError extends Error {
  readonly code: string = "MERCHANT_BLOCKED";
  constructor(public merchantId: string, message = `merchant ${merchantId} is blocked`) { super(message); }
}

/** The banker, or the merchant it belongs to, is suspended or terminated. Answered like a block (403). */
export class MerchantSuspendedError extends MerchantBlockedError {
  readonly code = "MERCHANT_SUSPENDED";
  constructor(merchantId: string) { super(merchantId, `merchant ${merchantId} is suspended`); }
}

/** The banker belongs to an exclusive partner (lib/partner): it takes partner orders only. Answered 403. */
export class PartnerOnlyError extends MerchantBlockedError {
  readonly code = "PARTNER_ONLY";
  constructor(merchantId: string) { super(merchantId, `merchant ${merchantId} takes orders through the partner API only`); }
}

/** The banker's merchant was onboarded for payouts only (lib/merchant-services). Answered 403. */
export class PayinNotEnabledError extends MerchantBlockedError {
  readonly code = "PAYIN_NOT_ENABLED";
  constructor(merchantId: string) { super(merchantId, `pay-ins are not enabled for merchant ${merchantId}`); }
}

// Onboarding stages and merchant statuses that take no new pay-ins.
export const CLOSED_STAGES = new Set(["SUSPENDED", "TERMINATED", "REJECTED"]);
export const CLOSED_STATUSES = new Set(["SUSPENDED", "TERMINATED"]);

/**
 * Create a Katana Pay order. When the banker's MID switch (lib/mid-switch) picked a gateway
 * account and that account could not create the order, the order is tried again on the next
 * account the switch allows, and the failure counts against the first one's health. An account
 * still on its go-live checklist that may not take this order (lib/gateway-golive) is passed over
 * the same way, without counting against its health. A banker with one account, or none in the
 * switch, gets the error as before.
 */
export async function createKatanaOrder(input: CreateKatanaOrderInput): Promise<CreateKatanaOrderResult> {
  if (input.routeAcrossBankers && input.merchantId) {
    const sw = await switchForSigner(input.merchantId);
    if (sw) return createAcrossBankers(input, input.merchantId, sw);
  }
  return createOnBanker(input);
}

/** Why an attempt on one banker is a reason to offer the order to the next one, or null when it is not. */
export function passOverCode(err: unknown): string | null {
  if (err instanceof MerchantBlockedError) return err.code;          // blocked, suspended, pay-ins off
  if (err instanceof PayinFlowError) return err.code;
  if (err instanceof OrderRefTakenError) return err.code;
  if (err instanceof PayinLimitError) return "LIMIT";
  if (err instanceof NoMidAvailableError) return err.code;
  if (err instanceof AccountNotLiveError) return err.code;
  if (err instanceof LiveModeNotActivatedError) return "LIVE_MODE_NOT_ACTIVATED";
  if (err instanceof PayuIntentError) return "PROCESSOR_ERROR";
  if (err instanceof PayinSetupError) return "SETUP";
  return null;
}

/**
 * THE BANKER SWITCH (lib/banker-switch): the merchant's bankers are offered the order in the
 * switch's order, and the first that can take it does. Each attempt is the whole order path of
 * that banker (its block, live mode, flow, limits, MIDs), so nothing is checked twice or skipped.
 * A replay signed with the same Key is answered first, from whichever banker took it.
 */
async function createAcrossBankers(
  input: CreateKatanaOrderInput, signer: string, sw: NonNullable<Awaited<ReturnType<typeof switchForSigner>>>,
): Promise<CreateKatanaOrderResult> {
  const livemode = input.livemode !== false;
  const prior = await readExistingOrder(input.orderId, signer, livemode);
  if (prior) return prior;

  const codes = sw.members.map((m) => m.banker_code);
  const [withKey, today] = await Promise.all([bankersWithKey(codes, livemode), bankerToday(codes, livemode)]);
  const order = bankerOrder(sw.members, sw.settings, new Date(), {
    ordersToday: Object.fromEntries(Object.entries(today).map(([b, t]) => [b, t.orders])),
  });
  // Nobody in rotation: the order is the signer's, as without the switch.
  if (!order.length) return createOnBanker(input);

  const passed: { banker: string; code: string }[] = [];
  let first: unknown = null;
  for (const c of order) {
    if (c.banker !== signer && !withKey.has(c.banker)) { passed.push({ banker: c.banker, code: "NO_KEY" }); continue; }
    try {
      const r = await createOnBanker({ ...input, merchantId: c.banker, signedBy: c.banker === signer ? null : signer });
      if (!r.reused) {
        await noteTaken(sw.providerId, c.banker, { how: c.how, signed_by: signer, txnid: input.orderId, passed_over: passed }).catch(() => {});
        if (passed.length) await logSwitchEvent(sw.providerId, "PASSED_OVER", "switch", c.banker,
          { txnid: input.orderId, signed_by: signer, passed_over: passed.map((p) => ({ ...p, why: passOverWords(p.code) })) }).catch(() => {});
      }
      return r;
    } catch (err) {
      const code = passOverCode(err);
      if (!code) throw err;
      passed.push({ banker: c.banker, code });
      first ??= err;
    }
  }
  await logSwitchEvent(sw.providerId, "NONE_AVAILABLE", "switch", null,
    { txnid: input.orderId, signed_by: signer, passed_over: passed.map((p) => ({ ...p, why: passOverWords(p.code) })) }).catch(() => {});
  await raiseAlert({
    key: `banker-switch:none:${sw.providerId}`, severity: "WARN", repeatMinutes: 30,
    title: "Banker switch: no banker could take an order",
    body: passed.map((p) => `${p.banker} ${passOverWords(p.code)}`).join("; "),
  }).catch(() => {});
  if (first) throw first;
  // Every banker in the order was passed over for having no Key: the signer's own path answers.
  return createOnBanker(input);
}

async function createOnBanker(input: CreateKatanaOrderInput): Promise<CreateKatanaOrderResult> {
  const exclude = [...(input.excludeMids ?? [])];
  for (;;) {
    try {
      return await createKatanaOrderOnce({ ...input, excludeMids: exclude });
    } catch (err) {
      const skipped = (err as { skippedMid?: Mid }).skippedMid;
      const failed = (err as { failedMid?: Mid }).failedMid ?? skipped;
      if (!failed || exclude.length >= 5) throw err;
      if (!skipped) await recordCreateFailure(failed, (err as Error).message);
      exclude.push(failed.id);
      // No other account can take it: answer with what went wrong on this one, not "no account".
      const next = await pickMidForOrder(failed.banker_code, "GATEWAY", input.amount, exclude)
        .catch((e) => { if (e instanceof NoMidAvailableError) return null; throw e; });
      if (!next) throw err;
    }
  }
}

async function createKatanaOrderOnce(input: CreateKatanaOrderInput): Promise<CreateKatanaOrderResult> {
  const orderId = input.orderId;
  const note = `Order ${orderId}`;
  // TEST ORDERS CANNOT MOVE MONEY. They pay the sandbox UPI ID (never a request receiver or
  // the merchant's saved settlement VPA), never call a live gateway, and carry no sub-MID
  // attribution — so a real customer cannot pay one, and none counts toward real volume.
  const livemode = input.livemode !== false;

  // Risk: a blocked merchant cannot create new pay-ins, and neither can a suspended or
  // terminated one. A failed read refuses the order: "could not tell" is not "not blocked".
  if (input.merchantId) {
    const b = await rows<{ blocked: boolean | null; stage: string | null }>("merchant", `
      SELECT (SELECT blocked FROM merchant_payment_config WHERE merchant_code = $1) AS blocked,
             (SELECT stage FROM merchants WHERE merchant_code = $1 LIMIT 1) AS stage
    `, [input.merchantId]);
    if (b[0]?.blocked === true) throw new MerchantBlockedError(input.merchantId);
    if (CLOSED_STAGES.has(b[0]?.stage ?? "")) throw new MerchantSuspendedError(input.merchantId);
    // A live order needs live mode activated for this merchant (lib/live-activation). Checked here
    // so every route that creates a pay-in — key-signed or from the dashboard — is covered.
    if (livemode) await assertLiveActivated(input.merchantId);
  }

  // THE MERCHANT'S PAY-IN FLOW DECIDES THE RAIL (lib/payin-flow). P2P: the order is a UPI link
  // to the banker's own UPI ID and no gateway is asked. INTENT: a gateway takes the payment, and
  // an order no gateway can take is refused rather than quietly sent to a UPI ID. No flow
  // selected yet (null): the routing below is inferred from what the merchant has, as before.
  const setting = await getEffectiveFlow(input.merchantId);
  // The merchant this banker belongs to (a `providers` row) is suspended: its bankers take nothing.
  if (input.merchantId && setting.providerId) {
    const p = await rows<{ status: string }>("provider",
      `SELECT status FROM providers WHERE id = $1::uuid`, [setting.providerId]).catch(() => []);
    if (CLOSED_STATUSES.has(p[0]?.status ?? "")) throw new MerchantSuspendedError(input.merchantId);
    // A merchant onboarded for payouts only takes no pay-in order, on any flow.
    if (!allowsPayin(await getProviderServices(setting.providerId))) throw new PayinNotEnabledError(input.merchantId);
    // An exclusive partner's bankers take the partner's orders only (lib/partner). A staff live test
    // from the banker page is Katana's own order and is still allowed.
    if (!input.partner && !input.staffTest && await isExclusivePartner(setting.providerId)) throw new PartnerOnlyError(input.merchantId);
  }
  const decided = decideOrderFlow({ flow: setting.flow, active: setting.active }, input.flow ?? null);
  if (!decided.ok) throw new PayinFlowError(decided.error, decided.code);
  const flow = decided.flow;
  // An Intent order may go to an Intent gateway account; a P2P order never does. A P2P order may
  // go to a P2P processor account (lib/pg-catalog gatewayAccountChannel: the customer pays a UPI
  // ID of the banker's own and the processor confirms it, e.g. PayAtom); an Intent order never
  // does. With no flow selected either may take it, as the routing always did.
  const gatewayAllowed = flow !== "P2P";
  const p2pProviderAllowed = flow !== "INTENT";

  // Route through the merchant's ACTIVE sub-MID, if one is set. The sub-MID reuses
  // the parent merchant's API key but carries its own identity, so payin volume is
  // attributable per sub-MID. Best-effort: never block order creation on this.
  let subMidCode: string | null = null;
  if (input.merchantId && livemode) {
    const sm = await rows<{ sub_mid_code: string }>(
      "mid",
      `SELECT sub_mid_code FROM sub_mids WHERE merchant_id = $1 AND active_payin = true LIMIT 1`,
      [input.merchantId],
    ).catch(() => []);
    subMidCode = sm[0]?.sub_mid_code ?? null;
  }

  // Resolve the receiver VPA(s): explicit on the request first, else the merchant's
  // configured settlement VPA. Without this a hosted-checkout order that doesn't pass
  // a receiver would point the QR at the sandbox payee instead of the merchant's bank.
  let receivers = livemode
    ? (input.receiverVpas?.length ? input.receiverVpas : (input.receiverVpa ? [input.receiverVpa] : []))
        .map((v) => v.trim()).filter(Boolean)
    : [];
  const saved = input.merchantId && livemode
    ? (await rows<{ v: string | null; name: string | null; name_vpa: string | null }>(
        "merchant", `SELECT katana_pay->>'settlement_vpa' AS v, katana_pay->>'payee_name' AS name, katana_pay->>'payee_name_vpa' AS name_vpa
                       FROM merchant_payment_config WHERE merchant_code = $1`, [input.merchantId],
      ).catch(() => []))[0]
    : undefined;
  const savedVpa = saved?.v?.trim() || null;
  if (!receivers.length && savedVpa) receivers = [savedVpa];
  let { pool, active } = buildVpaPool({ ...input, receiverVpas: receivers, receiverVpa: null });
  // The saved payee name belongs to the one UPI ID it was entered for (payee_name_vpa, bound by
  // the payment-config API). It is sent only when the order pays exactly that account: a
  // receiver passed on the request, or a settlement VPA changed since, is an account whose
  // registered name we do not know — and a wrong name is itself a decline signal.
  const nameVpa = saved?.name_vpa?.trim().toLowerCase() || null;
  let payeeName = active && nameVpa && active.toLowerCase() === nameVpa
    ? saved?.name?.trim() || null : null;
  const mode = input.mode === "INTENT" ? "INTENT" : "QR";

  // A REPLAYED ORDER IS ANSWERED FIRST, as the order it was created as. It is not checked
  // against today's limits or routed again, and its ref never reaches a gateway twice (a
  // gateway refuses a reused transaction id).
  // A replay is found by the Key that signed it: the signer's own, or the one that sent the order
  // here through the banker switch (vendor_payin_orders_signer_mode_order_uk).
  const signerKey = input.signedBy ?? input.merchantId ?? null;
  const prior = await readExistingOrder(orderId, signerKey, livemode);
  if (prior) return prior;

  // THE MID SWITCH (lib/mid-switch): a banker with gateway accounts in its switch has this order
  // created on the one the switch picks (priority or weighted split, inside each account's limits,
  // hours and health, or the one switched to by hand). Without any, its one account is used as
  // before. NoMidAvailableError when it has accounts and none can take the order.
  const gatewayPick: MidPick | null = livemode && gatewayAllowed && input.merchantId
    ? await pickMidForOrder(input.merchantId, "GATEWAY", input.amount, input.excludeMids)
    : null;
  const vaultLabel = gatewayPick?.mid.vault_label ?? undefined;

  // PayU: a live order for a merchant with PayU Key + Salt gets its UPI intent from PayU, so the
  // customer pays PayU's collection account on the merchant's MID. A link built locally to the
  // merchant's own UPI ID is exactly what UPI apps decline. PayU then confirms the order
  // (lib/payu-result); the bank-credit matcher leaves these orders alone.
  // A partner's order never goes to an account on the partner's own gateway: the money would go
  // back to the partner it came from (lib/partner).
  const ownGateway = input.partner?.ownGateway?.toUpperCase() || null;
  let ownSkipped = false;
  const payuMid = livemode && gatewayAllowed && input.merchantId && ownGateway !== "PAYU"
    ? await getGatewayMid(input.merchantId, vaultLabel).then(payuKeySalt).catch(() => null)
    : null;
  // The other gateways with a UPI intent, on the same terms. CCAvenue has none, so its merchants
  // keep the direct UPI link.
  let anyAccount = livemode && (gatewayAllowed || p2pProviderAllowed) && !payuMid && input.merchantId
    ? await gatewayPayinFor(input.merchantId, vaultLabel).catch(() => null)
    : null;
  if (anyAccount && ownGateway && anyAccount.mid.gateway?.toUpperCase() === ownGateway) { anyAccount = null; ownSkipped = true; }
  // Only an account of this order's flow. A P2P processor account needs a UPI intent (the customer
  // pays the banker's UPI ID in it); the MID switch only picks for Intent, so a P2P order uses the
  // banker's first account. An Intent order the switch put on a P2P account moves on (below).
  const accountChannel = anyAccount ? gatewayAccountChannel(anyAccount.mid) : null;
  const connected = anyAccount && (accountChannel === "P2P" ? p2pProviderAllowed && !!anyAccount.connector.upiIntent : gatewayAllowed)
    ? anyAccount : null;
  const otherGw = connected?.connector.upiIntent ? connected : null;
  // Gateways with no UPI intent take the payment on their own hosted page: PayU with a Client ID +
  // Secret (payment links), RubyVault and iSmartPay. The order gets that page and the customer pays
  // there; the gateway's answer settles it. CCAvenue has none either, but its merchants keep the
  // direct UPI link to their own UPI ID.
  const linkGw = !otherGw && connected && connected.mid.gateway !== "CCAVENUE" ? connected : null;
  // The account the switch picked has no usable credentials: try the next one.
  if (gatewayPick && !payuMid && !otherGw && !linkGw) {
    // On the partner's own gateway: passed to the next account without counting against its health.
    if (ownSkipped) throw Object.assign(new PayuIntentError("the processor account picked for this order cannot take partner orders"), { skippedMid: gatewayPick.mid });
    throw Object.assign(new PayuIntentError("the processor account picked for this order has no usable credentials"), { failedMid: gatewayPick.mid });
  }

  // P2P: a banker with UPI IDs in its switch is paid on the one the switch picks, with the others
  // that can take the order kept as the order's backup UPI IDs. A receiver named on the request
  // is still honoured as it was.
  let upiPick: MidPick | null = null;
  if (livemode && input.merchantId && !payuMid && !otherGw && !linkGw && flow !== "INTENT"
      && !(input.receiverVpas?.length || input.receiverVpa)) {
    upiPick = await pickMidForOrder(input.merchantId, "UPI", input.amount, input.excludeMids);
    if (upiPick) {
      receivers = [upiPick.mid.upi_id!, ...upiPick.others.map((m) => m.upi_id!)];
      ({ pool, active } = buildVpaPool({ ...input, receiverVpas: receivers, receiverVpa: null }));
      payeeName = upiPick.mid.payee_name?.trim()
        || (active && nameVpa && active.toLowerCase() === nameVpa ? saved?.name?.trim() || null : null);
    }
  }
  const midPick = gatewayPick ?? upiPick;

  // LIMITS (lib/payin-limits): rate, ticket size, the UPI ceiling and the day's total. Checked
  // before a gateway is asked for anything, so a refused order costs the gateway nothing. The
  // usage is only read when a rate or daily limit is in force.
  let dailyLimit: number | null = null;
  if (input.merchantId) {
    const limits = effectivePayinLimits(await getPayinLimits(input.merchantId), platformPayinLimits());
    const usage = limits.maxTps != null || (livemode && limits.daily != null)
      ? await getPayinUsage(input.merchantId, livemode)
      : { dayAmount: 0, lastSecond: 0 };
    const breach = checkPayinLimits({ amount: input.amount, livemode, upi: !linkGw, limits, usage });
    if (breach) throw new PayinLimitError(breach);
    if (livemode) dailyLimit = limits.daily;
  }
  // A gateway account that is still on its go-live checklist takes a few small verification
  // payments and nothing else (lib/gateway-golive). An account with no checklist is not gated.
  const gatewayId = payuMid ? "PAYU" : (otherGw ?? linkGw)?.mid.gateway ?? null;
  // Per account: the one the switch picked, else the banker's first (vendorGateway 0041). An account
  // that may not take this order yet hands it to the next account in the switch.
  if (livemode && gatewayId && input.merchantId) {
    await assertGoLiveAllows(input.merchantId, gatewayId, input.amount, vaultLabel).catch((e) => {
      if (gatewayPick && e instanceof AccountNotLiveError) throw Object.assign(e, { skippedMid: gatewayPick.mid });
      throw e;
    });
  }

  let checkoutUrl: string | null = null;
  let merchantName: string | null = null;
  let gateway: PayuGatewayMeta | null = null;
  let appLinks: Record<string, string> | null = null;

  let payId: string, vendorTxnId: string, deeplinks: DeepLinks, upiIntent: string;
  const status = "PENDING";
  try {
  if (payuMid) {
    vendorTxnId = shortId("kp");   // PayU txnid: unique per MID, at most 25 characters
    const base = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
    const r = await createPayuUpiIntent(payuMid, {
      txnid: vendorTxnId, amount: input.amount.toFixed(2), productinfo: note,
      firstname: "Customer", email: "payments@katanapay.co",
      phone: input.customerPhone?.trim() || "9999999999",
      surl: `${base}/api/gateway/payu/return`, furl: `${base}/api/gateway/payu/return`,
    }, input.client ?? { ip: "127.0.0.1", deviceInfo: "Mozilla/5.0" });
    if (!r.ok) throw new PayuIntentError(r.error, r.code);

    payId = r.paymentId ?? shortId("pay");
    deeplinks = { upi: r.links.upi, paytm: r.links.paytm, phonepe: r.links.phonepe };
    upiIntent = r.links.upi;
    gateway = {
      provider: "PAYU", txnid: vendorTxnId, payment_id: r.paymentId, env: payuMid.env ?? "TEST",
      payee_vpa: new URLSearchParams(r.intentQuery).get("pa"),
    };
  } else if (otherGw) {
    const { mid, connector } = otherGw;
    const name = gatewayName(mid.gateway);
    // A live order must be paid on the merchant's live gateway account.
    if (mid.env !== "PROD") throw new PayuIntentError(`this merchant's ${name} credentials are sandbox (TEST); live orders need live credentials`);
    if (!payinProdEnabled(mid.gateway)) throw new PayuIntentError(`live ${name} payments are not switched on yet`);

    vendorTxnId = shortId("kp");   // fits every gateway's order-id rules (letters, digits, _)
    const r = await connector.upiIntent!(mid, {
      txnid: vendorTxnId, amountMinor: BigInt(Math.round(input.amount * 100)), currency: input.currency,
      productinfo: note, firstname: "Customer", email: "payments@katanapay.co",
      phone: input.customerPhone?.trim() || "9999999999",
      returnUrl: payinReturnUrl(connector.id, vendorTxnId), notifyUrl: payinWebhookUrl(connector.id),
      customerVpa: input.customerVpa ?? null,
    }, input.client ?? { ip: "127.0.0.1", deviceInfo: "Mozilla/5.0" });
    if (!r.ok) throw new PayuIntentError(r.error);

    const links = {
      upi: `upi://pay?${r.data.intentQuery}`,
      paytm: `paytm://upi/pay?${r.data.intentQuery}`,
      phonepe: `phonepe://upi/pay?${r.data.intentQuery}`,
    };
    // The processor's own app links, used on the pay page instead of rebuilt ones (PayAtom quasi intent).
    appLinks = r.data.appLinks ?? null;
    payId = r.data.paymentId ?? shortId("pay");
    deeplinks = links as DeepLinks;
    upiIntent = links.upi;
    // A processor that wants its own page used (pageFirst: PayAtom) makes this a hosted-page order:
    // the customer is sent straight to that page. Otherwise the page is only a fallback.
    const hostedPage = connector.pageFirst && r.data.redirectUrl ? r.data.redirectUrl : null;
    if (hostedPage) checkoutUrl = hostedPage;
    gateway = {
      provider: connector.id, txnid: vendorTxnId, payment_id: r.data.paymentId, env: mid.env ?? "TEST",
      payee_vpa: new URLSearchParams(r.data.intentQuery).get("pa"),
      ...(hostedPage ? { checkout_url: hostedPage } : r.data.redirectUrl ? { page_url: r.data.redirectUrl } : {}),
    };
  } else if (linkGw) {
    const { mid, connector } = linkGw;
    const name = gatewayName(mid.gateway);
    if (mid.env !== "PROD") throw new PayuIntentError(`this merchant's ${name} credentials are sandbox (TEST); live orders need live credentials`);
    if (!payinProdEnabled(payinProdId(mid))) throw new PayuIntentError(`live ${name}${mid.auth === "client_credentials" ? " (Client ID)" : ""} payments are not switched on yet`);

    vendorTxnId = shortId("kp");
    const r = await connector.checkout(mid, {
      txnid: vendorTxnId, amountMinor: BigInt(Math.round(input.amount * 100)), currency: input.currency,
      productinfo: note, firstname: "Customer", email: "payments@katanapay.co",
      phone: input.customerPhone?.trim() || "9999999999",
      returnUrl: payinReturnUrl(connector.path ?? connector.id, vendorTxnId), notifyUrl: payinWebhookUrl(connector.path ?? connector.id),
      customerVpa: input.customerVpa ?? null,
    }, input.client ?? { ip: "127.0.0.1", deviceInfo: "Mozilla/5.0" });
    if (!r.ok) throw new PayuIntentError(r.error);
    if (r.data.kind !== "redirect") throw new PayuIntentError(`${name} returned no payment page`);

    checkoutUrl = r.data.url;
    const who = await rows<{ n: string | null }>("merchant",
      `SELECT COALESCE(NULLIF(brand_name, ''), legal_name) AS n FROM merchants WHERE merchant_code = $1`, [input.merchantId],
    ).catch(() => []);
    merchantName = who[0]?.n?.trim() || null;
    payId = shortId("pay");
    // No UPI app link: the customer pays on the gateway's page.
    deeplinks = { upi: "", paytm: "", phonepe: "" };
    upiIntent = "";
    gateway = {
      // PayU Client ID orders stay under PAYU: the sweep and pay page pick the connector by auth.
      provider: mid.gateway === "PAYU" ? "PAYU" : connector.id, txnid: vendorTxnId, payment_id: null,
      env: mid.env ?? "TEST", payee_vpa: null,
      ...(mid.auth === "client_credentials" ? { auth: "client_credentials" as const } : {}),
      checkout_url: checkoutUrl,
    };
  } else {
    // A live order must pay a real account. With no gateway that takes the payment and no
    // receiver UPI ID, the only payee left is the sandbox one, which UPI apps refuse — so the
    // order is refused here instead of handing the customer a link that can never be paid.
    // An Intent order that reached here has no gateway able to take it.
    if (livemode && flow === "INTENT") {
      throw new PayinFlowError(
        `${input.merchantId ?? "this merchant"} is on the Intent flow but no pay-in gateway is connected that can take this payment`, "FLOW_NOT_READY");
    }
    if (livemode && !active) {
      throw new PayinSetupError(flow === "P2P"
        ? `${input.merchantId ?? "this merchant"} is on the P2P flow but has no settlement UPI ID to be paid on`
        : `${input.merchantId ?? "this merchant"} has no way to take this payment: connect a pay-in gateway or set a settlement UPI ID`);
    }
    payId = shortId("pay");
    // The vendor txn id carries the routing sub-MID as a prefix so each sub-MID
    // produces a distinct transaction identity (and is greppable per sub-MID).
    vendorTxnId = `${livemode ? "" : "test_"}${subMidCode ? subMidCode.toLowerCase() + "_" : ""}${shortId("txn")}`;
    const query = buildUpiQuery({ payeeVpa: active || undefined, payeeName, orderId, amount: input.amount, note });
    deeplinks = buildDeeplinks(query);
    upiIntent = deeplinks.upi;
  }
  } catch (err) {
    // The processor account the switch picked could not create the order: createKatanaOrder
    // tries the next one.
    if (gatewayPick && err instanceof PayuIntentError) throw Object.assign(err, { failedMid: gatewayPick.mid });
    throw err;
  }
  // Risk: high-amount hold — orders at/above the threshold are held for manual
  // review and are NOT auto-settled by the poller; ops must confirm them.
  const hold = input.amount >= HIGH_AMOUNT_HOLD;
  const meta = {
    deeplinks, upi_intent: upiIntent, qr_payload: upiIntent,
    ...(appLinks ? { app_links: appLinks } : {}),
    mode,                                  // QR | INTENT
    // A PayU order is paid to PayU's collection account, not the merchant's UPI ID.
    receiver_vpa: gateway ? gateway.payee_vpa : livemode ? (active ?? input.receiverVpa ?? null) : SANDBOX_PAYEE_VPA,
    vpa_pool: pool,                        // [{ vpa, status }] for backup failover
    sender_vpa: input.customerVpa ?? null,
    sub_mid_code: subMidCode,
    hold,                                  // high-amount → manual review
    hold_reason: hold ? `amount >= ${HIGH_AMOUNT_HOLD}` : null,
    return_url: input.returnUrl ?? null,   // browser redirect after pay
    ...(merchantName ? { merchant_name: merchantName } : {}),   // shown on Katana's pay page
    notify_url: input.notifyUrl ?? null,   // per-order S2S callback target
    ...(input.requestId ? { request_id: input.requestId } : {}),   // also in the status history (vendorGateway 0033)
    ...(input.apiVersion ? { api_version: input.apiVersion } : {}),
    // The banker switch sent it here: the Key that signed it, whose callback settings it keeps.
    ...(input.signedBy ? { signed_by: input.signedBy } : {}),
    ...(input.staffTest ? { staff_test: { by: input.staffTest.by, at: new Date().toISOString() } } : {}),
    // A partner's order (lib/partner): its callback goes to the partner, not the banker.
    ...(input.partner ? { partner: { id: input.partner.partnerId, sub_merchant_id: input.partner.subMerchantId,
      sub_merchant: input.partner.subCode, external_id: input.partner.externalId } } : {}),
    ...(input.metadata && Object.keys(input.metadata).length ? { metadata: input.metadata } : {}),
    // The MID the switch picked (lib/mid-switch): its account is used for every later call about
    // this order (lib/gateway-creds orderVaultLabel), and why it was picked.
    ...(midPick ? { mid: {
      id: midPick.mid.id, name: midPick.mid.name, kind: midPick.mid.kind, vault_label: midPick.mid.vault_label,
      how: midPick.choice.how, reason: midPick.choice.reason,
    } } : {}),
    // Which integration config drove this order (cascade visibility).
    gateway,                               // PayU txnid + payment id when PayU issued the intent
    integration: !livemode ? { source: "test", env: "SANDBOX", live: false }
      : gateway ? { source: gateway.provider.toLowerCase(), env: gateway.env, live: true }
      : { source: "direct", env: "PROD", live: false },
  };

  // The collection rail, fixed here for the life of the order (vendorGateway 0029). Routing is
  // decided above, so the requested and the final channel are the same.
  // A test order never reaches a gateway, so it has none to be classified by: on the Intent
  // flow it is an Intent order all the same, taken by the sandbox. Without this it was written
  // as P2P, the Intent API answered `flow: "P2P"` and the Intent status lookup did not find it.
  const payinChannel = !gateway?.provider && flow === "INTENT"
    ? { type: "INTENT" as const, id: SANDBOX_CHANNEL_ID }
    : classifyPayinOrder(gateway?.provider, otherGw ? accountChannel : null);

  const insertSql = `
    INSERT INTO vendor_payin_orders
      (tenant_id, vendor, merchant_id, sub_mid_code, pay_id, order_id, amount, currency_code, channel,
       vendor_txn_id, response_code, status, customer_vpa, customer_phone, meta, livemode,
       channel_type, channel_id, requested_channel, payin_mid_id, signed_by${input.partner ? ", partner_id, partner_sub_merchant_id" : ""})
    VALUES ('tenant-default','KATANA',$1,$2,$3,$4,$5,$6,$7,$8,'U17',$9,$10,$11,$12::jsonb,$13,$14,$15,$14,$16::uuid,$17${input.partner ? ",$18::uuid,$19::uuid" : ""})
    -- Either key: this banker's own txnid (0026) or the signing Key's (0042).
    ON CONFLICT DO NOTHING
    RETURNING id::text, order_id, pay_id, vendor_txn_id, sub_mid_code, amount, currency_code, channel, status, created_at, livemode,
              channel_type, channel_id
  `;
  const insertArgs = [input.merchantId ?? null, subMidCode, payId, orderId, input.amount, input.currency, input.channel ?? "UPI_INTENT",
      vendorTxnId, status, input.customerVpa ?? null, input.customerPhone ?? null, JSON.stringify(meta), livemode,
      payinChannel.type, payinChannel.id, midPick?.mid.id ?? null, input.signedBy ?? null,
      ...(input.partner ? [input.partner.partnerId, input.partner.subMerchantId] : [])];
  // With a daily limit in force, or a MID with limits, the insert is made under the banker's and
  // the MID's locks, where the totals are read again: orders arriving together cannot pass a
  // limit between them.
  const midLimited = !!midPick && (midPick.mid.daily_amount != null || midPick.mid.daily_count != null || midPick.mid.monthly_amount != null);
  const inserted = (dailyLimit != null || midLimited) && input.merchantId
    ? await insertOrderWithinLimits<any>({ banker: input.merchantId, amount: input.amount, bankerDaily: dailyLimit,
        mid: midPick?.mid ?? null, sql: insertSql, args: insertArgs })
    : await rows<any>("vendorGateway", insertSql, insertArgs);

  if (inserted.length) return { order: inserted[0], deeplinks, upiIntent, reused: false, checkoutUrl, checkoutGateway: checkoutUrl ? gateway?.provider ?? null : null, banker: input.merchantId ?? null };

  // Two requests for the same ref raced and the other one inserted first.
  const raced = await readExistingOrder(orderId, signerKey, livemode);
  // Nothing under the signing Key: the conflict was this banker's own txnid on an order another
  // Key signed (or one sent here by the banker switch). That txnid is taken on this banker.
  if (!raced) throw new OrderRefTakenError(orderId);
  return raced;
}

// IDEMPOTENT REPLAY — AND IT MUST BE SCOPED TO THE MERCHANT (the banker whose Key signed it).
//
// The insert conflicts on (vendor, merchant, order_id), so re-read on the SAME key.
// Re-reading by (vendor, order_id) alone is what made a colliding txnid hand one
// merchant another merchant's order — its UUID, its amount and its deeplinks, so the
// payer was sent to the wrong collection VPA (migration 0024). The merchant predicate
// mirrors the index expression exactly, NULL included.
//
// The signer is the order's own banker, except on an order the banker switch moved, where it is
// `signed_by` (vendorGateway 0042); the predicate mirrors that index expression exactly.
export async function readExistingOrder(orderId: string, signer: string | null, livemode: boolean): Promise<CreateKatanaOrderResult | null> {
  const existing = await rows<any>("vendorGateway", `
    SELECT id::text, order_id, pay_id, vendor_txn_id, sub_mid_code, amount, currency_code,
           channel, status, created_at, livemode, channel_type, channel_id, meta, merchant_id
      FROM vendor_payin_orders
     WHERE vendor = 'KATANA'
       AND order_id = $1
       AND COALESCE(signed_by, merchant_id, '') = COALESCE($2, '')
       AND livemode = $3        -- a test order must never replay the live order with the same ref
  `, [orderId, signer, livemode]);
  const ex = existing[0];
  if (!ex) return null;
  // `meta` carries the receiver VPA, the VPA pool, the sub-MID and confirmation detail.
  // It is needed here for the stored deeplinks, but it is not part of the caller's
  // order shape — strip it so it cannot reach an API response.
  const { meta: exMeta, merchant_id: exBanker, ...exOrder } = ex as Record<string, unknown> & { meta?: Record<string, unknown>; merchant_id?: string | null };
  const storedMeta = exMeta ?? {};
  return {
    order: exOrder,
    deeplinks: storedMeta.deeplinks as DeepLinks,
    upiIntent: storedMeta.upi_intent as string,
    reused: true,
    checkoutUrl: (storedMeta.gateway as PayuGatewayMeta | null | undefined)?.checkout_url ?? null,
    checkoutGateway: (storedMeta.gateway as PayuGatewayMeta | null | undefined)?.checkout_url
      ? (storedMeta.gateway as PayuGatewayMeta).provider : null,
    banker: exBanker ?? null,
  };
}

// ── Payment verification / confirmation ───────────────────────────────────────────
// A Katana pay-in stays PENDING until the credit is verified in the receiver /
// settlement account. Two channels feed the SINGLE confirmation core below so they
// can never diverge:
//   • ops manual confirm  — POST /api/vendors/katana/order/:id/confirm
//   • gateway webhook      — POST /api/vendors/katana/callback (settlement credit)
// A sender screenshot does NOT call this directly: it is self-asserted, low-trust
// evidence, so it only parks the order in PROOF_SUBMITTED (see attachPayinProof)
// and an ops person confirms it here after viewing the proof.

export type KatanaEvidence = "UTR" | "SCREENSHOT" | "WEBHOOK" | "MANUAL" | "DEVICE" | "EMAIL";

export interface ConfirmKatanaOrderInput {
  id?: string;                 // vendor_payin_orders.id (uuid) — ops path
  orderRef?: string;           // order_id (our reference) — webhook path
  merchantId?: string | null;  // merchant code that scopes an orderRef lookup
  // The mode the EVIDENCE belongs to. A real bank credit or a live-secret webhook passes true, a
  // simulator or test-secret webhook passes false; the order must be in that mode. Omitted only
  // by human decisions (ops confirm, manual case), which may act on either.
  livemode?: boolean;
  outcome: "SUCCESS" | "FAILED";
  utr?: string | null;         // UTR/RRN from bank / scrape / screenshot / gateway
  note?: string | null;
  evidence: KatanaEvidence;
  actor: string;               // ops email, or what confirmed it ("gateway:webhook", "device:…")
  settlementStatus?: string | null; // gateway settlement state, e.g. "SETTLED"
}

export interface ConfirmKatanaOrderResult {
  ok: boolean;
  status: number;              // suggested HTTP status for the caller
  order?: { id: string; order_id: string; status: string; rrn: string };
  error?: string;
  idempotent?: boolean;        // true when a terminal order already matched the outcome
}

// Single source of truth for marking a Katana pay-in paid/failed. Enforces the
// final-status lock (idempotent for webhook retries; a confirmed payment revives an EXPIRED
// or FAILED order, nothing changes a paid one), duplicate-UTR blocking, and
// records who/what/how confirmed it on meta.confirmation. settlementStatus=SETTLED
// additionally stamps meta.settlement so the dashboard can distinguish "paid" from
// "settled to the receiver account".
export async function confirmKatanaOrder(input: ConfirmKatanaOrderInput, retried = false): Promise<ConfirmKatanaOrderResult> {
  const key = input.id ?? input.orderRef;
  if (!key) return { ok: false, status: 400, error: "id or orderRef required" };
  // An order ref is unique per MERCHANT, not platform-wide (vendorGateway 0024/0025). A lookup
  // by ref is therefore scoped to the merchant when the caller knows it, and REFUSED when the
  // ref belongs to more than one merchant — never resolved to whichever row came back first.
  const expected = typeof input.livemode === "boolean" ? input.livemode : null;
  const cur = input.id
    ? await rows<any>("vendorGateway",
        `SELECT id::text, order_id, status, COALESCE(rrn,'') AS rrn, meta, livemode
           FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'KATANA'`, [key])
    : await rows<any>("vendorGateway",
        `SELECT id::text, order_id, status, COALESCE(rrn,'') AS rrn, meta, livemode
           FROM vendor_payin_orders
          WHERE order_id = $1 AND vendor = 'KATANA'
            AND ($2::text IS NULL OR merchant_id = $2)
            AND ($3::boolean IS NULL OR livemode = $3)
          LIMIT 2`, [key, input.merchantId?.trim() || null, expected]);
  if (!cur.length) return { ok: false, status: 404, error: "not found" };
  if (cur.length > 1)
    return { ok: false, status: 409, error: `order ${key} exists for more than one merchant — include merchant_code` };
  const order = cur[0];

  // EVIDENCE AND ORDER MUST BE IN THE SAME MODE. A real credit can never mark a test order paid,
  // and a simulator or test-secret webhook can never mark a live order paid.
  if (expected !== null && (order.livemode !== false) !== expected)
    return { ok: false, status: 409, error: expected
      ? "a test order cannot be confirmed by live evidence"
      : "a live order cannot be confirmed by test evidence" };

  // Final-status lock. A retried webhook delivering the same terminal outcome is a
  // safe idempotent replay; a conflicting outcome is rejected.
  //
  // EXPIRED and FAILED are SOFT terminals. EXPIRED only means "we stopped waiting"; FAILED
  // means an attempt was declined, and on a gateway's payment page the customer can try again
  // on the same order. A real, confirmed payment landing on either REVIVES the order to
  // SUCCESS (the customer paid, so we honour it rather than stranding the money). Nothing else
  // moves them: an expired order is never failed, a failed one never expired.
  // SUCCESS/SUCCEEDED is HARD final and never changes.
  const reviving = (order.status === "EXPIRED" || order.status === "FAILED") && input.outcome === "SUCCESS";
  if (KATANA_TERMINAL.has(order.status) && !reviving) {
    if (order.status === input.outcome)
      return { ok: true, status: 200, idempotent: true, order: { id: order.id, order_id: order.order_id, status: order.status, rrn: order.rrn } };
    return { ok: false, status: 409, error: `order already ${order.status}` };
  }

  // Duplicate-UTR blocking — a UTR/RRN may settle exactly one order OF ITS MODE. Across live
  // orders this stays platform-wide on purpose: a real UPI reference is unique network-wide, so
  // one payment can never settle two merchants' orders. Test orders carry generated references,
  // which must never block a real one.
  if (input.outcome === "SUCCESS" && input.utr?.trim()) {
    const dup = await rows<{ order_id: string }>("vendorGateway",
      `SELECT order_id FROM vendor_payin_orders WHERE rrn = $1 AND id <> $2::uuid AND livemode = $3 LIMIT 1`,
      [input.utr.trim(), order.id, order.livemode !== false]);
    if (dup.length) return { ok: false, status: 409, error: `duplicate UTR — already used by order ${dup[0].order_id}` };
  }

  const rrn = input.outcome === "SUCCESS" ? (input.utr?.trim() || genRrn(order.id)) : null;
  const responseCode = input.outcome === "SUCCESS" ? "00" : "U30";
  const settled = input.outcome === "SUCCESS" && input.settlementStatus?.toUpperCase() === "SETTLED";
  const now = new Date().toISOString();
  // Only the keys this confirmation sets. They are merged into the stored meta by the UPDATE
  // below, never written over it: the row read above may be stale by now, and writing it back
  // whole would drop what was stamped since (the callback record, a gateway check).
  const meta = {
    review: input.outcome === "SUCCESS" ? "CONFIRMED" : "REJECTED",
    confirmation: {
      by: input.actor, at: now, evidence: input.evidence,
      utr: input.utr ?? null, note: input.note ?? null,
      settlement_status: input.settlementStatus ?? null,
    },
    ...(settled ? { settlement: { status: "SETTLED", at: now } } : {}),
    ...(reviving ? { [order.status === "FAILED" ? "revived_from_failed" : "revived_from_expired"]: { at: now, by: input.actor } } : {}),
  };

  let upd: any[];
  try {
    upd = await rows<any>("vendorGateway", `
      UPDATE vendor_payin_orders
         SET status = $2, response_code = $3, rrn = COALESCE($4, rrn),
             meta = COALESCE(meta, '{}'::jsonb) || $5::jsonb, updated_at = now()
       WHERE id = $1::uuid AND status = $6
      RETURNING id::text, order_id, status, COALESCE(rrn,'') AS rrn
    `, [order.id, input.outcome, responseCode, rrn, JSON.stringify(meta), order.status]);
  } catch (err) {
    // Another order was confirmed with this reference between the check above and this write.
    // The unique index (vendorGateway 0035) is what makes that impossible to get past.
    if ((err as { code?: string }).code === "23505")
      return { ok: false, status: 409, error: "duplicate UTR — already used by another order" };
    throw err;
  }

  // The order changed between the read and the write: another confirmation landed, or the sweep
  // expired it. Nothing was written. Decide again on the fresh row, once — it then answers as an
  // idempotent replay, a revive, or a conflict, exactly as if this call had arrived second.
  if (!upd.length) {
    if (!retried) return confirmKatanaOrder(input, true);
    return { ok: false, status: 409, error: "order changed while it was being confirmed — retry" };
  }

  // The order just reached a terminal status — POST the signed status callback to
  // the merchant's server (best-effort; idempotent; retried by the outbox).
  sendPayinCallback(order.id).catch(() => {});

  return { ok: true, status: 200, order: upd[0] };
}

export interface AttachProofInput {
  orderId: string;        // vendor_payin_orders.id (uuid)
  orderRef: string;
  kind?: string;          // SCREENSHOT | RECEIPT | BANK_SLIP
  utr?: string | null;
  filename?: string | null;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  storageRef: string;
  uploadedBy?: string;
}

// Records a sender-uploaded payment proof and parks the order in PROOF_SUBMITTED so
// the poller stops auto-expiring it (see autoResolvePaused) and ops sees it needs
// verification. Does NOT settle the order — confirmKatanaOrder does that on review.
export async function attachPayinProof(input: AttachProofInput): Promise<{ proof_id: string }> {
  const ins = (await rows<{ id: string }>("vendorGateway", `
    INSERT INTO vendor_payin_proofs
      (order_id, order_ref, kind, utr, filename, content_type, size_bytes, sha256, storage_ref, uploaded_by)
    VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text
  `, [input.orderId, input.orderRef, (input.kind ?? "SCREENSHOT").toUpperCase(), input.utr ?? null,
      input.filename ?? null, input.contentType, input.sizeBytes, input.sha256, input.storageRef,
      input.uploadedBy ?? "sender"]))[0];

  // Park for review: PROOF_SUBMITTED pauses auto-resolution; stamp the proof summary
  // on meta so the cockpit/confirm dialog can show it without a join.
  await rows("vendorGateway", `
    UPDATE vendor_payin_orders
       SET meta = COALESCE(meta,'{}'::jsonb) || $2::jsonb, updated_at = now()
     WHERE id = $1::uuid AND status NOT IN ('SUCCESS','SUCCEEDED','FAILED','EXPIRED')
  `, [input.orderId, JSON.stringify({
    review: "PROOF_SUBMITTED",
    proof: { submitted_at: new Date().toISOString(), utr: input.utr ?? null, sha256: input.sha256, filename: input.filename ?? null },
  })]).catch(() => {});

  return { proof_id: ins.id };
}
