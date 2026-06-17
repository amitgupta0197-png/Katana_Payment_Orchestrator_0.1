// Routing engine (BRD §6 P2).
//
//   provider_score =
//        success_rate_weight * recent_success_rate
//      + latency_weight      * normalized_latency_score
//      + cost_weight         * inverse_fee_score
//      + health_weight       * provider_health
//      + risk_weight         * risk_compatibility
//      - failure_penalty     * recent_failure_rate
//      - capacity_penalty    * utilization_ratio
//
// Sprint-4 additions:
//   - Filter out rails with kill_switch=true
//   - Filter out providers whose circuit is OPEN (HALF_OPEN is eligible
//     for one probe)
//   - Apply active A/B-test variant weights for the configured traffic split
//
// Returns an ORDERED candidate list (highest score first) — the orchestrator
// uses element 0 first and falls back to 1, 2, ... on retryable errors
// (BRD §6 cascading flow: Primary → Secondary → Tertiary).

import { createHash } from "crypto";
import { rows } from "@/lib/pg";
import { getCircuit, isOpenCircuit } from "@/lib/circuit-breaker";

export interface RoutingWeights {
  success_rate: number;
  latency: number;
  cost: number;
  health: number;
  risk: number;
  failure_penalty: number;
  capacity_penalty: number;
}

export const DEFAULT_WEIGHTS: RoutingWeights = {
  success_rate: 0.35,
  latency: 0.15,
  cost: 0.10,
  health: 0.20,
  risk: 0.05,
  failure_penalty: 0.10,
  capacity_penalty: 0.05,
};

export interface RoutingInput {
  method: string;                     // UPI | CARD | NETBANKING | WALLET | QR | CRYPTO
  amountMinor: bigint | number;
  currency: string;
  merchantId: string;
  riskScore?: number;                 // 0..1, default 0.5 (mid)
  weights?: Partial<RoutingWeights>;
  txnId?: string;                     // for stable A/B bucketing
}

export interface CandidateFactors {
  recent_success_rate: number;
  normalized_latency_score: number;
  inverse_fee_score: number;
  provider_health: number;
  risk_compatibility: number;
  recent_failure_rate: number;
  utilization_ratio: number;
}

export interface RouteCandidate {
  provider: string;
  method: string;
  score: number;
  factors: CandidateFactors;
  rank: number;
  reasoning: string;
}

interface RailRow {
  provider: string; method: string; weight: number; mdr_bps: number;
  enabled: boolean; kill_switch: boolean;
}
interface HealthRow {
  provider_code: string; success_rate: number; p95_latency_ms: number;
  failure_rate: number; utilization: number;
}
interface ExperimentRow {
  experiment_id: string; name: string;
  control_weights: RoutingWeights; variant_weights: RoutingWeights;
  traffic_split: number; method_scope: string | null;
}

const LATENCY_FLOOR_MS = 100;
const LATENCY_CEILING_MS = 2000;
const FEE_CEILING_BPS = 500; // 5%

function normalizeLatency(p95: number): number {
  if (p95 <= LATENCY_FLOOR_MS) return 1.0;
  if (p95 >= LATENCY_CEILING_MS) return 0.0;
  return 1 - (p95 - LATENCY_FLOOR_MS) / (LATENCY_CEILING_MS - LATENCY_FLOOR_MS);
}

function inverseFee(mdr_bps: number): number {
  if (mdr_bps <= 0) return 1.0;
  if (mdr_bps >= FEE_CEILING_BPS) return 0.0;
  return 1 - mdr_bps / FEE_CEILING_BPS;
}

function clamp(x: number, lo = 0, hi = 1): number { return Math.max(lo, Math.min(hi, x)); }

// Deterministic bucket in [0, 1) from (merchant_id + tag) so the same
// merchant+txn always lands in the same A/B arm.
function bucketHash(seed: string): number {
  const h = createHash("sha256").update(seed).digest();
  const n = h.readUInt32BE(0);
  return n / 0xFFFFFFFF;
}

async function activeExperiment(method: string): Promise<ExperimentRow | null> {
  const m = method.toUpperCase();
  const r = await rows<ExperimentRow>("routingEngine", `
    SELECT experiment_id::text, name,
           control_weights, variant_weights,
           traffic_split::float AS traffic_split, method_scope
      FROM routing_experiments
     WHERE enabled = true
       AND (method_scope IS NULL OR method_scope = $1)
       AND (started_at IS NULL OR started_at <= now())
       AND (ended_at   IS NULL OR ended_at   >  now())
     ORDER BY started_at DESC NULLS LAST
     LIMIT 1
  `, [m]).catch(() => []);
  return r[0] ?? null;
}

export async function pickRoute(input: RoutingInput): Promise<{
  candidates: RouteCandidate[];
  weights_applied: RoutingWeights;
  excluded: { provider: string; method: string; reason: string }[];
  experiment: { id: string; name: string; bucket: "CONTROL" | "VARIANT" } | null;
}> {
  const explicit = input.weights ? { ...DEFAULT_WEIGHTS, ...input.weights } : null;
  const exp = await activeExperiment(input.method);

  // Experiment wins over merchant default unless caller supplied explicit weights.
  let weights_applied: RoutingWeights;
  let experimentResult: { id: string; name: string; bucket: "CONTROL" | "VARIANT" } | null = null;
  if (explicit) {
    weights_applied = explicit;
  } else if (exp) {
    const seed = `${exp.experiment_id}:${input.merchantId}:${input.txnId ?? ""}`;
    const b = bucketHash(seed);
    const bucket: "CONTROL" | "VARIANT" = b < exp.traffic_split ? "VARIANT" : "CONTROL";
    weights_applied = bucket === "VARIANT" ? exp.variant_weights : exp.control_weights;
    experimentResult = { id: exp.experiment_id, name: exp.name, bucket };
  } else {
    weights_applied = DEFAULT_WEIGHTS;
  }

  const risk = clamp(input.riskScore ?? 0.5);

  const rails = await rows<RailRow>("routingEngine", `
    SELECT provider, method, weight, mdr_bps, enabled, kill_switch
      FROM rails
     WHERE direction='PAYIN' AND enabled = true AND method = $1
  `, [input.method.toUpperCase()]).catch(() => []);

  const excluded: { provider: string; method: string; reason: string }[] = [];
  if (rails.length === 0) {
    return { candidates: [], weights_applied, excluded, experiment: experimentResult };
  }

  const eligibleRails: RailRow[] = [];
  for (const rail of rails) {
    if (rail.kill_switch) {
      excluded.push({ provider: rail.provider, method: rail.method, reason: "kill_switch" });
      continue;
    }
    const c = await getCircuit(rail.provider);
    if (isOpenCircuit(c)) {
      excluded.push({ provider: rail.provider, method: rail.method, reason: "circuit_open" });
      continue;
    }
    eligibleRails.push(rail);
  }

  if (eligibleRails.length === 0) {
    return { candidates: [], weights_applied, excluded, experiment: experimentResult };
  }

  const health = await rows<HealthRow>("routingEngine", `
    SELECT provider_code, success_rate::float AS success_rate,
           p95_latency_ms, failure_rate::float AS failure_rate,
           utilization::float AS utilization
      FROM provider_health_snapshot
     WHERE provider_code = ANY($1::text[])
  `, [eligibleRails.map(r => r.provider)]).catch(() => []);
  const healthByProvider = new Map(health.map(h => [h.provider_code, h]));

  const w = weights_applied;
  const candidates: RouteCandidate[] = eligibleRails.map((rail) => {
    const h = healthByProvider.get(rail.provider) ?? {
      provider_code: rail.provider,
      success_rate: 0.95, p95_latency_ms: 500, failure_rate: 0.05, utilization: 0.5,
    };
    const factors: CandidateFactors = {
      recent_success_rate: h.success_rate,
      normalized_latency_score: normalizeLatency(h.p95_latency_ms),
      inverse_fee_score: inverseFee(rail.mdr_bps),
      provider_health: clamp(1 - h.failure_rate),
      risk_compatibility: 1 - Math.abs(0.5 - risk),
      recent_failure_rate: h.failure_rate,
      utilization_ratio: h.utilization,
    };
    const score =
        w.success_rate     * factors.recent_success_rate
      + w.latency          * factors.normalized_latency_score
      + w.cost             * factors.inverse_fee_score
      + w.health           * factors.provider_health
      + w.risk             * factors.risk_compatibility
      - w.failure_penalty  * factors.recent_failure_rate
      - w.capacity_penalty * factors.utilization_ratio;

    const reasoning = [
      `success ${(factors.recent_success_rate * 100).toFixed(1)}%`,
      `p95 ${h.p95_latency_ms}ms`,
      `mdr ${rail.mdr_bps}bps`,
      `util ${(factors.utilization_ratio * 100).toFixed(0)}%`,
    ].join(" · ");

    return { provider: rail.provider, method: rail.method, score, factors, rank: 0, reasoning };
  });

  candidates.sort((a, b) => b.score - a.score);
  candidates.forEach((c, i) => { c.rank = i + 1; });

  return { candidates, weights_applied, excluded, experiment: experimentResult };
}

export async function persistDecision(input: {
  orderId: string; merchantId: string; method: string;
  amountMinor: bigint | number; currency: string;
  candidates: RouteCandidate[]; weightsApplied: RoutingWeights;
  selectedRank?: number;
  txnId: string;
  experimentId?: string | null;
  experimentBucket?: string | null;
}): Promise<string> {
  const winner = input.candidates[input.selectedRank ? input.selectedRank - 1 : 0];
  const decided = await rows<{ id: string }>("routingEngine", `
    INSERT INTO routing_decisions
      (txn_id, candidates, winner, score, order_id, merchant_id, method,
       amount_minor, currency, cascade_ranks, factors, selected_rank, weights_applied,
       experiment_id, experiment_bucket)
    VALUES ($1, $2::jsonb, $3, $4, $5::uuid, $6, $7,
            $8, $9, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14, $15)
    ON CONFLICT (txn_id) DO UPDATE SET
      candidates=EXCLUDED.candidates, winner=EXCLUDED.winner, score=EXCLUDED.score,
      cascade_ranks=EXCLUDED.cascade_ranks, factors=EXCLUDED.factors,
      selected_rank=EXCLUDED.selected_rank, weights_applied=EXCLUDED.weights_applied,
      experiment_id=EXCLUDED.experiment_id, experiment_bucket=EXCLUDED.experiment_bucket,
      decided_at=now()
    RETURNING id::text
  `, [
    input.txnId,
    JSON.stringify(input.candidates.map(c => ({ provider: c.provider, method: c.method, score: c.score }))),
    winner?.provider ?? "none",
    winner?.score ?? 0,
    input.orderId, input.merchantId, input.method,
    String(input.amountMinor), input.currency,
    JSON.stringify(input.candidates.map(c => ({ rank: c.rank, provider: c.provider, score: c.score, reasoning: c.reasoning }))),
    JSON.stringify(Object.fromEntries(input.candidates.map(c => [c.provider, c.factors]))),
    input.selectedRank ?? 1,
    JSON.stringify(input.weightsApplied),
    input.experimentId ?? null,
    input.experimentBucket ?? null,
  ]);
  return decided[0].id;
}
