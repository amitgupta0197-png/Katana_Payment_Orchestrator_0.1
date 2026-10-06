// Which services a merchant takes, and what its onboarding has to set up for them.
//
// PURE (no `pg`, no server imports): the dashboards import the same rules the APIs enforce.
//
//   PAYIN   the merchant collects payments. Its bankers take pay-in orders and send no payouts.
//   PAYOUT  the merchant sends payouts. Its bankers take no pay-in orders.
//   BOTH    both.
//   UNSET   nobody has chosen: every merchant from before the choice existed. It may do both,
//           as it always could.
//
// The choice is made when the merchant (a `providers` row) is created, together with its pay-in
// flow (lib/payin-flow): a merchant that takes pay-ins is put on P2P, Intent or Both; a
// payout-only merchant has no pay-in flow.

import { PAYIN_FLOW_LABEL, validateMerchantFlow, type MerchantFlow, type OrderFlow, type PayinFlow } from "@/lib/payin-flow";

export const MERCHANT_SERVICES = ["PAYIN", "PAYOUT", "BOTH"] as const;
export type MerchantServices = (typeof MERCHANT_SERVICES)[number];
export type MerchantServicesSetting = MerchantServices | "UNSET";

export const SERVICES_LABEL: Record<MerchantServicesSetting, string> = {
  PAYIN: "Pay-in", PAYOUT: "Pay-out", BOTH: "Pay-in and pay-out", UNSET: "Not selected",
};

export const SERVICES_HINT: Record<MerchantServices, string> = {
  PAYIN: "Collects payments from customers. No payouts.",
  PAYOUT: "Sends payouts to beneficiaries. Takes no pay-in orders.",
  BOTH: "Collects payments and sends payouts.",
};

export function parseServices(v: unknown): MerchantServicesSetting {
  const s = typeof v === "string" ? v.toUpperCase() : "";
  return (MERCHANT_SERVICES as readonly string[]).includes(s) ? (s as MerchantServices) : "UNSET";
}

/** An unset merchant may do both, as before the choice existed. */
export const allowsPayin = (s: MerchantServicesSetting) => s !== "PAYOUT";
export const allowsPayout = (s: MerchantServicesSetting) => s !== "PAYIN";

/**
 * What is chosen when a merchant is created: the services, and for one that takes pay-ins its
 * flow. Returns what is wrong with the choice, or null.
 */
export function validateOnboardingChoice(
  services: MerchantServices, flow: PayinFlow | null | undefined, active: OrderFlow | null | undefined,
): string | null {
  if (services === "PAYOUT") return flow ? "a pay-out only merchant has no pay-in flow" : null;
  if (!flow) return "select the pay-in flow: P2P, Intent or Both";
  return validateMerchantFlow(flow, active);
}

// ── What a banker needs before it goes live ───────────────────────────────────────────────

export type SetupKey = "CHOICE" | "P2P_UPI_ID" | "INTENT_GATEWAY" | "INTENT_H2H" | "PAYOUT_GATEWAY";
export type SetupState = "DONE" | "MISSING" | "OPTIONAL_MISSING";

export interface SetupItem {
  key: SetupKey;
  label: string;
  state: SetupState;
  /** What to do about it; staff wording, never shown to a merchant with a gateway's name. */
  hint: string;
}

/** What a banker has in place. Read by lib/merchant-services-store. */
export interface SetupFacts {
  /** The banker has a settlement UPI ID to be paid on. */
  upiId: boolean;
  /** A pay-in gateway is connected for the banker. */
  payinGateway: boolean;
  /** A payout gateway is connected for the banker. */
  payoutGateway: boolean;
  /** The banker's merchant needs host-to-host checkout (providers.needs_h2h). */
  needsH2h?: boolean;
  /** The checkout mode of the banker's pay-in account (lib/pg-catalog gatewayCheckoutMode). */
  intentCheckout?: "H2H" | "REDIRECT" | null;
}

/**
 * The setup a banker needs for what its merchant was onboarded for. A flow the merchant is on
 * must be ready; with Both flows, the one in use must be and the other only should be. A
 * payout gateway is optional: without one, payouts are paid from the Katana balance.
 */
export function setupItems(services: MerchantServicesSetting, flow: MerchantFlow, facts: SetupFacts): SetupItem[] {
  const items: SetupItem[] = [];
  const payin = allowsPayin(services), payout = allowsPayout(services);
  if (services === "UNSET" && flow.flow === "UNSET") {
    return [{ key: "CHOICE", label: "Services and pay-in flow: nothing selected", state: "OPTIONAL_MISSING",
      hint: "Nothing was selected for this banker's merchant. Select its services and pay-in flow on the merchant's page." }];
  }
  if (payin && flow.flow === "UNSET") {
    items.push({ key: "CHOICE", label: "Pay-in flow selected", state: "MISSING",
      hint: "The merchant takes pay-ins but has no pay-in flow. Select P2P, Intent or Both on the merchant's page." });
  }
  if (payin && flow.flow !== "UNSET") {
    const needs = (f: OrderFlow): SetupState | null =>
      flow.flow === f || (flow.flow === "BOTH" && flow.active === f) ? "MISSING" : flow.flow === "BOTH" ? "OPTIONAL_MISSING" : null;
    const p2p = needs("P2P"), intent = needs("INTENT");
    if (p2p) items.push({ key: "P2P_UPI_ID", label: `${PAYIN_FLOW_LABEL.P2P}: settlement UPI ID saved`,
      state: facts.upiId ? "DONE" : p2p, hint: "Save the banker's settlement UPI ID under Payment configuration." });
    if (intent) items.push({ key: "INTENT_GATEWAY", label: `${PAYIN_FLOW_LABEL.INTENT}: pay-in gateway connected`,
      state: facts.payinGateway ? "DONE" : intent, hint: "Save the banker's pay-in gateway credentials." });
    // A merchant that needs host-to-host is flagged (never refused) when its account only redirects.
    if (intent && facts.needsH2h && facts.payinGateway)
      items.push({ key: "INTENT_H2H", label: `${PAYIN_FLOW_LABEL.INTENT}: host-to-host payment account`,
        state: facts.intentCheckout === "H2H" ? "DONE" : "OPTIONAL_MISSING",
        hint: "The merchant needs host-to-host checkout, but this banker's payment account only redirects to the gateway's page. Connect a host-to-host gateway." });
  }
  if (payout && services !== "UNSET") {
    items.push({ key: "PAYOUT_GATEWAY", label: "Pay-out: payout gateway connected",
      state: facts.payoutGateway ? "DONE" : "OPTIONAL_MISSING",
      hint: "No payout gateway is connected: payouts will be paid from the merchant's Katana balance." });
  }
  return items;
}

// What each required item means to a person turning live mode on: what to do, in plain words.
const LIVE_SETUP_WORDS: Partial<Record<SetupKey, string>> = {
  CHOICE: "Choose how this merchant's customers pay (P2P, Intent or both) first",
  P2P_UPI_ID: "Save the UPI ID where P2P payments arrive first",
  INTENT_GATEWAY: "Connect a payment account for Intent payments first",
};

/**
 * Why live mode cannot be switched on yet (lib/live-activation): one line per required item that
 * is missing, the same rule as the go-live SETUP gate. Empty when nothing required is missing,
 * which includes every banker nobody chose a flow for.
 */
export function liveSetupMissing(items: SetupItem[]): string[] {
  return items.filter((i) => i.state === "MISSING").map((i) => LIVE_SETUP_WORDS[i.key] ?? i.label);
}

/** The go-live gate over those items: a required one missing fails, an optional one asks for a look. */
export function setupVerdict(items: SetupItem[]): { result: "PASS" | "REVIEW" | "FAIL"; summary: string } {
  const missing = items.filter((i) => i.state === "MISSING");
  const optional = items.filter((i) => i.state === "OPTIONAL_MISSING");
  if (missing.length) return { result: "FAIL", summary: `not set up: ${missing.map((i) => i.label).join("; ")}` };
  if (optional.length) return { result: "REVIEW", summary: optional.map((i) => i.hint).join(" ") };
  return { result: "PASS", summary: "Everything the merchant was onboarded for is set up" };
}

// ── What "Activate live mode" asks a banker for (lib/live-activation) ─────────────────────

export interface LiveChecklistNeeds {
  settlementVpa: boolean;
  payinGateway: boolean;
  testPayment: boolean;
  /** A test payout went through (the payout sandbox, lib/payout-providers/sandbox). */
  testPayout: boolean;
}

/**
 * A banker nobody chose for is asked what it always was: a settlement UPI ID and a test payment.
 * Once a choice exists the checklist follows it: the UPI ID for P2P (or Both with P2P in use),
 * the pay-in gateway for Intent (or Both with Intent in use), and for a pay-out only merchant a
 * test payout in place of a test payment. (It used to be asked for an approved beneficiary
 * instead, because it had no way to make a test payout before the payout sandbox existed.)
 */
export function liveChecklistNeeds(services: MerchantServicesSetting, flow: MerchantFlow): LiveChecklistNeeds {
  const payin = allowsPayin(services);
  const inUse: OrderFlow | null = flow.flow === "BOTH" ? flow.active : flow.flow === "UNSET" ? null : flow.flow;
  return {
    settlementVpa: payin && (inUse === null || inUse === "P2P"),
    payinGateway: payin && inUse === "INTENT",
    testPayment: payin,
    testPayout: services === "PAYOUT",
  };
}

// ── A suggested choice for a merchant from before the choice existed ──────────────────────

/** What a merchant's bankers have actually done and have in place. Read by lib/merchant-setup. */
export interface MerchantEvidence {
  bankers: number;
  /** Live pay-ins over the window, by the flow each was taken on. */
  p2pOrders: number;
  intentOrders: number;
  /** Payouts sent over the window. */
  payouts: number;
  bankersWithUpi: number;
  bankersWithGateway: number;
  bankersWithPayoutGateway: number;
  days: number;
}

export interface Suggestion {
  services: MerchantServices | null;
  flow: PayinFlow | null;
  active: OrderFlow | null;
  /** Why, in staff words. Empty when there is nothing to go on. */
  reasons: string[];
}

const n = (x: number, one: string, many = `${one}s`) => `${x.toLocaleString("en-IN")} ${x === 1 ? one : many}`;

/**
 * What a merchant most likely is, from what its bankers did: pay-ins and payouts taken, and the
 * UPI IDs and gateways they have. Staff confirm it; nothing is saved from a suggestion alone.
 * With Both flows the default is the one more orders took (P2P on a tie).
 */
export function suggestChoice(e: MerchantEvidence): Suggestion {
  const reasons: string[] = [];
  const p2p = e.p2pOrders > 0 || e.bankersWithUpi > 0;
  const intent = e.intentOrders > 0 || e.bankersWithGateway > 0;
  const payin = p2p || intent;
  const payout = e.payouts > 0 || e.bankersWithPayoutGateway > 0;
  if (e.p2pOrders) reasons.push(`${n(e.p2pOrders, "P2P pay-in")} in the last ${e.days} days`);
  if (e.intentOrders) reasons.push(`${n(e.intentOrders, "Intent pay-in")} in the last ${e.days} days`);
  if (!e.p2pOrders && e.bankersWithUpi) reasons.push(`${n(e.bankersWithUpi, "banker")} with a settlement UPI ID`);
  if (!e.intentOrders && e.bankersWithGateway) reasons.push(`${n(e.bankersWithGateway, "banker")} with a pay-in gateway`);
  if (e.payouts) reasons.push(`${n(e.payouts, "payout")} in the last ${e.days} days`);
  else if (e.bankersWithPayoutGateway) reasons.push(`${n(e.bankersWithPayoutGateway, "banker")} with a payout gateway`);
  const services: MerchantServices | null = payin && payout ? "BOTH" : payin ? "PAYIN" : payout ? "PAYOUT" : null;
  const flow: PayinFlow | null = !payin ? null : p2p && intent ? "BOTH" : p2p ? "P2P" : "INTENT";
  const active: OrderFlow | null = flow === "BOTH" ? (e.intentOrders > e.p2pOrders ? "INTENT" : "P2P") : null;
  return { services, flow, active, reasons };
}
