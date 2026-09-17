// What every payout connector (PayU, RazorpayX, Cashfree, Paytm) provides, in one shape.
//
// lib/provider-payout-order drives payouts through this interface only, so the rules that
// keep money safe (guarded status moves, "no answer is not a failure", amount checks,
// reversal alerts) are written once and hold for every gateway.
//
// Nothing here throws. A call that got no usable answer reports definite=false: the caller
// must treat that as "unknown", never as "failed". A payout marked failed while the gateway is
// actually paying it invites the merchant to pay the same person twice.

import type { GatewayEnv, GatewayId } from "@/lib/pg-catalog";

export type PayoutRail = "IMPS" | "NEFT" | "RTGS" | "UPI";

export type ProviderCall<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; definite: boolean };

export interface TransferInput {
  /** The reference the gateway knows the transfer by (see PayoutConnector.providerRefFor). */
  ref: string;
  /** Katana's txn_ref, where a gateway has room for a second reference. */
  txnRef: string;
  amountMinor: bigint;          // paise
  rail: PayoutRail;
  purpose: string;
  beneficiaryName: string;
  accountNumber?: string | null;
  ifsc?: string | null;
  vpa?: string | null;
}

/**
 * The gateway's view of one transfer, reduced to what Katana acts on.
 * `final` is SUCCESS / FAILED / REVERSED, or null while the transfer is still in flight.
 */
export interface TransferState {
  found: boolean;
  ref?: string;
  final?: "SUCCESS" | "FAILED" | "REVERSED" | null;
  status?: string;              // the gateway's own status word, verbatim
  providerRef?: string;         // the gateway's id for the transfer
  bankRef?: string;             // UTR / RRN
  amountMinor?: bigint;
  msg?: string;
  raw?: Record<string, unknown>;
}

export interface PayoutConnector<C extends { env: GatewayEnv }> {
  id: GatewayId;
  name: string;
  /** Rails this gateway can pay on. */
  rails: PayoutRail[];
  /** The merchant's credentials for this gateway, or null if their payout gateway is another one. */
  creds(merchantCode: string): Promise<C | null>;
  /** Katana's txn_ref as the gateway accepts it (some gateways refuse hyphens). */
  providerRefFor(txnRef: string): string;
  /** The inverse, for webhooks that only carry the gateway-side reference. */
  txnRefFrom(providerRef: string): string;
  /** Ask the gateway to pay. ok=true only means it accepted the request; the result comes later. */
  transfer(c: C, t: TransferInput): Promise<ProviderCall<{ providerRef?: string; state?: TransferState }>>;
  /** What the gateway says happened. found=false is not a failure on its own (it may be lag). */
  status(c: C, ref: string, opts: { createdAt: Date; providerRef?: string | null; timeoutMs?: number }): Promise<ProviderCall<TransferState>>;
  /** Every transfer in a date range, for reconciliation. Gateways without a list API omit it. */
  list?(c: C, from: Date, to: Date): Promise<ProviderCall<(TransferState & { ref: string })[]>>;
  /** Available payout balance. Gateways without a balance API omit it. */
  balance?(c: C): Promise<ProviderCall<{ balanceMinor: bigint; lowBalance: boolean }>>;
  /** Register Katana's webhook with the gateway by API (PayU). Others are set in their dashboard. */
  registerWebhook?(merchantCode: string, c: C): Promise<ProviderCall<{ url: string }>>;
}

/** Katana's webhook endpoint for a gateway's payout events. Not a secret. */
export function payoutWebhookUrlFor(id: GatewayId): string {
  const base = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
  return `${base}/api/gateway/${id.toLowerCase()}/payout-webhook`;
}

/** Rupees with two decimals, from paise, without going through a float. */
export function rupees(minor: bigint): string {
  const neg = minor < 0n; const v = neg ? -minor : minor;
  return `${neg ? "-" : ""}${v / 100n}.${(v % 100n).toString().padStart(2, "0")}`;
}

/** Paise from a gateway's rupee amount (number or string), or undefined if it isn't one. */
export function paiseFrom(v: unknown): bigint | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? BigInt(Math.round(n * 100)) : undefined;
}

/** YYYY-MM-DD in India, whatever the server's zone. */
export function istDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
}

/**
 * Gateways live in PROD only once a sandbox payout has been seen end to end. PayU is proven;
 * the others are switched on per gateway with PAYOUT_CONNECTORS_PROD=PAYU,RAZORPAY,...
 */
export function prodEnabled(id: GatewayId): boolean {
  const list = (process.env.PAYOUT_CONNECTORS_PROD ?? "PAYU").split(",").map((s) => s.trim().toUpperCase());
  return list.includes(id);
}
