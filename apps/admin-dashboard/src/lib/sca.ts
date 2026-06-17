// 3DS2 / SCA decision engine (BRD §7 P3).
//
// For card payments, decide BEFORE calling the adapter whether to:
//   FRICTIONLESS — adapter is told NOT to challenge
//   CHALLENGE    — adapter MUST present 3DS2 challenge
//   EXEMPTED     — Low-Value-Payment, Trusted-Beneficiary, etc.
//
// Decision = (always_challenge) OR (risk_score ≥ threshold) OR (amount ≥ threshold)
// EXEMPTIONS:
//   amount < challenge_above_minor AND risk_score < threshold → LVP exemption
//   beneficiary trusted (token vault flag) → TRA exemption (Sprint 6)
//
// BRD §7 acceptance: "Every card transaction records auth status, challenge
// result, exemption reason, attempt number, final state." Components above
// the engine consume `auth_status` + `exemption_reason` and persist them on
// checkout_attempts (Sprint 2 already added those columns).

import { rows } from "@/lib/pg";

export type ScaFlow = "FRICTIONLESS" | "CHALLENGE" | "EXEMPTED";

export interface ScaInput {
  merchantId: string;
  method: string;             // CARD only triggers SCA; other methods → FRICTIONLESS
  amountMinor: bigint | number | string;
  currency: string;
  country?: string;
  riskScore: number;          // 0..1 from lib/risk.ts
  hasNetworkToken?: boolean;  // token vault flag — trusted beneficiary path
}

export interface ScaDecision {
  flow: ScaFlow;
  reason: string;
  exemption_reason?:
    | "LOW_VALUE_PAYMENT"
    | "TRUSTED_BENEFICIARY"
    | "MERCHANT_INITIATED"
    | "TRANSACTION_RISK_ANALYSIS"
    | "RECURRING"
    | null;
  policy_id?: string;
}

interface PolicyRow {
  policy_id: string;
  always_challenge: boolean;
  challenge_above_minor: string;
  risk_score_threshold: number;
}

async function loadPolicy(input: ScaInput): Promise<PolicyRow | null> {
  // Best-match policy: merchant+country+method > merchant+method > platform default.
  const m = input.method.toUpperCase();
  const country = (input.country ?? "").toUpperCase();
  const r = await rows<PolicyRow>("riskVelocity", `
    SELECT policy_id::text, always_challenge,
           challenge_above_minor::text AS challenge_above_minor,
           risk_score_threshold::float AS risk_score_threshold
      FROM sca_policies
     WHERE enabled = true
       AND (method IS NULL OR method = $1)
       AND (merchant_id IS NULL OR merchant_id = $2)
       AND (country IS NULL OR country = $3)
     ORDER BY (merchant_id IS NOT NULL)::int DESC,
              (country     IS NOT NULL)::int DESC,
              (method      IS NOT NULL)::int DESC,
              created_at DESC
     LIMIT 1
  `, [m, input.merchantId, country]).catch(() => []);
  return r[0] ?? null;
}

export async function decideSca(input: ScaInput): Promise<ScaDecision> {
  if (input.method.toUpperCase() !== "CARD") {
    return { flow: "FRICTIONLESS", reason: "non-card method does not require SCA" };
  }
  const policy = await loadPolicy(input);
  if (!policy) {
    return { flow: "FRICTIONLESS", reason: "no SCA policy matched; default frictionless" };
  }
  const amount = Number(input.amountMinor);
  const threshold = Number(policy.challenge_above_minor);

  if (policy.always_challenge) {
    return { flow: "CHALLENGE", reason: "policy.always_challenge", policy_id: policy.policy_id };
  }
  if (input.riskScore >= policy.risk_score_threshold) {
    return {
      flow: "CHALLENGE", policy_id: policy.policy_id,
      reason: `risk_score ${input.riskScore.toFixed(4)} ≥ threshold ${policy.risk_score_threshold}`,
    };
  }
  if (amount >= threshold) {
    return {
      flow: "CHALLENGE", policy_id: policy.policy_id,
      reason: `amount_minor ${amount} ≥ challenge_above_minor ${threshold}`,
    };
  }
  // LVP exemption — below threshold and risk score low.
  return {
    flow: "EXEMPTED", policy_id: policy.policy_id,
    reason: `LVP: amount_minor ${amount} < ${threshold} and risk ${input.riskScore.toFixed(4)} < ${policy.risk_score_threshold}`,
    exemption_reason: "LOW_VALUE_PAYMENT",
  };
}
