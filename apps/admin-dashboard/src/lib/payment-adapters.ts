// Provider adapter contract (BRD §3 "Contract Testing" + §7 "provider adapter").
//
// Every PG / bank / VASP adapter implements `PaymentAdapter`. Real adapters
// go through the BFF over gRPC to the provider-specific microservice; for
// Sprint 2 the sandbox impls below run inline so the dashboard can drive an
// end-to-end lifecycle without any external dependency.
//
// Deterministic outcomes — the adapter behaves identically on every replay,
// so contract tests and screenshots in the docs match what users see.

import type { PaymentState } from "@/lib/payment-states";

export interface ChargeRequest {
  orderId: string;
  txnId: string;
  amountMinor: bigint;
  currency: string;
  method: string;
  customerEmail?: string;
  attemptNo: number;
}

export interface ChargeResult {
  provider: string;
  outcome: "SUCCESS" | "AUTH_REQUIRED" | "PROCESSING" | "FAILED";
  nextState: PaymentState;
  providerTxnId?: string;
  authStatus?: "FRICTIONLESS" | "CHALLENGE_REQUIRED" | "AUTHENTICATED" | "EXEMPTED" | "NOT_REQUIRED";
  challengeUrl?: string;
  exemptionReason?: string;
  errorCode?: string;
  errorMessage?: string;
  responseTimeMs: number;
  raw: Record<string, unknown>;
}

export interface RefundRequest {
  providerTxnId: string;
  amountMinor: bigint;
  currency: string;
}
export interface RefundResult {
  provider: string;
  ok: boolean;
  refundId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface PaymentAdapter {
  code: string;
  charge(req: ChargeRequest): Promise<ChargeResult>;
  refund(req: RefundRequest): Promise<RefundResult>;
  getStatus(providerTxnId: string): Promise<{ status: string; raw: Record<string, unknown> }>;
}

// Sandbox: deterministic outcomes based on order/amount so the lifecycle is
// reproducible. Behaviour matrix is encoded in `sandboxOutcome` below.
//
//   amount_minor % 100 == 13   → FAILED (synthetic decline)
//   amount_minor % 100 == 17   → AUTH_REQUIRED + 3DS challenge URL
//   amount_minor % 100 == 19   → PROCESSING (async; expects callback)
//   else                       → SUCCESS frictionless
//
// This lets us drive every BRD state without a real provider.
function sandboxOutcome(provider: string, req: ChargeRequest): ChargeResult {
  const slot = Number(req.amountMinor % 100n);
  const baseLatency = provider === "POOLPAY" ? 230 : provider === "QUICKPAY" ? 410 : 200;
  const responseTimeMs = baseLatency + (slot % 50);
  const providerTxnId = `${provider.toLowerCase()}_${req.txnId.slice(-12)}`;

  if (slot === 13) {
    return {
      provider, outcome: "FAILED", nextState: "FAILED",
      providerTxnId, errorCode: "DECLINED",
      errorMessage: "issuer declined: insufficient funds (sandbox)",
      responseTimeMs, raw: { sandbox: true, slot, rule: "decline_on_13" },
    };
  }
  if (slot === 17 && req.method.toUpperCase() === "CARD") {
    return {
      provider, outcome: "AUTH_REQUIRED", nextState: "AUTH_REQUIRED",
      providerTxnId, authStatus: "CHALLENGE_REQUIRED",
      challengeUrl: `/3ds-sim/${providerTxnId}`, responseTimeMs,
      raw: { sandbox: true, slot, rule: "3ds_challenge_on_17" },
    };
  }
  if (slot === 19) {
    return {
      provider, outcome: "PROCESSING", nextState: "PROCESSING",
      providerTxnId, authStatus: "FRICTIONLESS",
      responseTimeMs, raw: { sandbox: true, slot, rule: "async_pending_on_19" },
    };
  }
  return {
    provider, outcome: "SUCCESS", nextState: "SUCCESS",
    providerTxnId, authStatus: "NOT_REQUIRED",
    responseTimeMs, raw: { sandbox: true, slot, rule: "default_success" },
  };
}

function makeAdapter(code: string): PaymentAdapter {
  return {
    code,
    async charge(req) { return sandboxOutcome(code, req); },
    async refund(req) {
      return {
        provider: code, ok: true,
        refundId: `${code.toLowerCase()}_rf_${req.providerTxnId.slice(-8)}`,
      };
    },
    async getStatus(providerTxnId) {
      return { status: "SUCCESS", raw: { sandbox: true, providerTxnId } };
    },
  };
}

const ADAPTERS = new Map<string, PaymentAdapter>([
  ["POOLPAY",  makeAdapter("POOLPAY")],
  ["QUICKPAY", makeAdapter("QUICKPAY")],
  ["CASHFREE", makeAdapter("CASHFREE")],
  ["PAYU",     makeAdapter("PAYU")],
  ["RAZORPAY", makeAdapter("RAZORPAY")],
]);

export function getAdapter(code: string): PaymentAdapter {
  const a = ADAPTERS.get(code.toUpperCase());
  if (!a) throw new Error(`no adapter for provider: ${code}`);
  return a;
}

export function listAdapterCodes(): string[] {
  return Array.from(ADAPTERS.keys());
}
