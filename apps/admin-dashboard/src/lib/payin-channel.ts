// Pay-in channel — the collection rail a pay-in was taken on.
//
// PURE (no `pg`, no server imports): the dashboards import the same definitions the API uses.
//
//   INTENT        a gateway issues the payment and confirms it (PayU, RubyVault, iSmartPay, …).
//   P2P           the payer pays a banker's own UPI ID; the proof is a bank credit.
//   UNCLASSIFIED  a legacy row whose rail was never recorded. Shown as such, never guessed.
//
// One merchant collects on several rails. The channel is written when the pay-in is created
// (vendorGateway 0029) and every total is built per channel first; "All" is only ever the sum.

export const PAYIN_CHANNELS = ["INTENT", "P2P", "UNCLASSIFIED"] as const;
export type PayinChannel = (typeof PAYIN_CHANNELS)[number];

export const PAYIN_CHANNEL_LABEL: Record<PayinChannel, string> = {
  INTENT: "INTENT", P2P: "P2P", UNCLASSIFIED: "Unclassified",
};

export function payinChannelVariant(c: PayinChannel): "brand" | "info" | "warning" {
  return c === "INTENT" ? "brand" : c === "P2P" ? "info" : "warning";
}

/** A `?channel=` value. Anything that is not a channel (including ALL) means "no filter". */
export function parsePayinChannel(v: string | null | undefined): PayinChannel | null {
  const s = (v ?? "").toUpperCase();
  return (PAYIN_CHANNELS as readonly string[]).includes(s) ? (s as PayinChannel) : null;
}

/** A stored value read back; a row from before the column existed is UNCLASSIFIED. */
export function payinChannelOf(v: unknown): PayinChannel {
  return parsePayinChannel(typeof v === "string" ? v : null) ?? "UNCLASSIFIED";
}

/** The rail of the direct UPI link to a banker's own UPI ID, and of every captured credit. */
export const P2P_CHANNEL_ID = "UPI_DIRECT";

/**
 * The channel of a new Katana Pay order: INTENT when a gateway takes the payment, P2P when the
 * customer is sent to the banker's own UPI ID.
 */
export function classifyPayinOrder(gatewayProvider: string | null | undefined): { type: PayinChannel; id: string } {
  if (gatewayProvider) return { type: "INTENT", id: gatewayProvider };
  return { type: "P2P", id: P2P_CHANNEL_ID };
}

// checkout_orders are taken by a payment gateway by construction, so they are INTENT.
export const CHECKOUT_ORDER_CHANNEL: PayinChannel = "INTENT";
