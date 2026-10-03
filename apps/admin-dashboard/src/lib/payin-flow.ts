// Pay-in business flow — which Katana pay-in flow a merchant is on.
//
// PURE (no `pg`, no server imports): the dashboards import the same rules the APIs enforce.
//
//   P2P     the payer pays the banker's own UPI ID; the proof is a bank credit.
//   INTENT  a payment gateway issues the payment and confirms it.
//   BOTH    the merchant is set up for both. `active` then says which of the two the
//           merchant's orders take; either flow's own API can still be called directly.
//   UNSET   nobody has chosen for this merchant yet. Its orders keep the routing they always
//           had (a gateway when one is connected, else the banker's UPI ID).
//
// The choice is made for the merchant by Katana (merchant 0010) and every order obeys it:
// a P2P merchant is never sent to a gateway, an INTENT merchant never to a bare UPI ID.
//
// A flow is the same thing as an order's channel_type (lib/payin-channel): the flow is what
// the merchant is allowed, the channel is what one order actually took.

export const ORDER_FLOWS = ["P2P", "INTENT"] as const;
/** The flow one order takes. */
export type OrderFlow = (typeof ORDER_FLOWS)[number];

export const PAYIN_FLOWS = ["P2P", "INTENT", "BOTH"] as const;
/** What a merchant can be set to. */
export type PayinFlow = (typeof PAYIN_FLOWS)[number];
export type PayinFlowSetting = PayinFlow | "UNSET";

export interface MerchantFlow {
  flow: PayinFlowSetting;
  /** BOTH only: the flow the merchant's orders take. null for every other setting. */
  active: OrderFlow | null;
}

export const UNSET_FLOW: MerchantFlow = { flow: "UNSET", active: null };

export const PAYIN_FLOW_LABEL: Record<PayinFlowSetting, string> = {
  P2P: "P2P", INTENT: "Intent", BOTH: "Both", UNSET: "Not selected",
};

export const PAYIN_FLOW_HINT: Record<PayinFlow, string> = {
  P2P: "Payers pay the banker's own UPI ID. Confirmed by a bank credit.",
  INTENT: "A payment gateway issues and confirms every payment.",
  BOTH: "Set up for both. One of the two is the default for orders that don't name a flow.",
};

export function parseOrderFlow(v: unknown): OrderFlow | null {
  const s = typeof v === "string" ? v.toUpperCase() : "";
  return (ORDER_FLOWS as readonly string[]).includes(s) ? (s as OrderFlow) : null;
}

export function parsePayinFlow(v: unknown): PayinFlowSetting {
  const s = typeof v === "string" ? v.toUpperCase() : "";
  return (PAYIN_FLOWS as readonly string[]).includes(s) ? (s as PayinFlow) : "UNSET";
}

/** A stored (flow, active) pair read back. A BOTH with no selection is treated as unset. */
export function merchantFlowOf(flow: unknown, active: unknown): MerchantFlow {
  const f = parsePayinFlow(flow);
  if (f !== "BOTH") return { flow: f, active: null };
  const a = parseOrderFlow(active);
  return a ? { flow: "BOTH", active: a } : UNSET_FLOW;
}

/** The flows a merchant may take an order on. Empty for UNSET. */
export function allowedFlows(m: MerchantFlow): OrderFlow[] {
  if (m.flow === "BOTH") return ["P2P", "INTENT"];
  return m.flow === "UNSET" ? [] : [m.flow];
}

/** True when the merchant shows up under this flow's module (BOTH shows up under each). */
export function isOnFlow(m: MerchantFlow, f: OrderFlow): boolean {
  return allowedFlows(m).includes(f);
}

export type FlowDecision =
  | { ok: true; flow: OrderFlow | null }   // null = UNSET merchant on the general API: the old inferred routing
  | { ok: false; error: string; code: "FLOW_NOT_SELECTED" | "FLOW_NOT_ENABLED" };

/**
 * The flow one new order takes.
 *
 *   requested   the flow asked for by name (the P2P API or the Intent API); null on the
 *               general order API.
 *
 *   P2P / INTENT merchant   always that flow; asking for the other one is refused.
 *   BOTH merchant           the requested flow, else the one selected as in use.
 *   UNSET merchant          the general API keeps the old inferred routing; a flow's own API
 *                           is refused until a flow is selected for the merchant.
 */
export function decideOrderFlow(m: MerchantFlow, requested?: OrderFlow | null): FlowDecision {
  if (m.flow === "UNSET") {
    return requested
      ? { ok: false, code: "FLOW_NOT_SELECTED", error: "no pay-in flow has been selected for this merchant yet" }
      : { ok: true, flow: null };
  }
  if (m.flow === "BOTH") return { ok: true, flow: requested ?? m.active };
  if (requested && requested !== m.flow) {
    return { ok: false, code: "FLOW_NOT_ENABLED", error: `${PAYIN_FLOW_LABEL[requested]} pay-ins are not enabled for this merchant` };
  }
  return { ok: true, flow: m.flow };
}

/** A setting is valid when BOTH names its flow in use and a single flow names none. */
export function validateMerchantFlow(flow: PayinFlow, active: OrderFlow | null | undefined): string | null {
  if (flow === "BOTH" && !active) return "select the default flow: P2P or Intent";
  if (flow !== "BOTH" && active) return "a default flow is only selected for Both";
  return null;
}
