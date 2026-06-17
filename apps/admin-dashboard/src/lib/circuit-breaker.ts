// Per-provider circuit breaker (BRD §6 P2 acceptance:
// "Provider outage triggers failover within 5 seconds").
//
//   CLOSED      → request flows normally
//   OPEN        → all requests skip this provider (treated as kill-switched)
//   HALF_OPEN   → one probe is allowed; success → CLOSED, failure → OPEN
//
// Trip rules (env-tunable):
//   THRESHOLD   = 3 consecutive failures  → trip to OPEN
//   COOLDOWN_S  = 60s (dev) / 300s (prod) → after which OPEN → HALF_OPEN
//
// The state lives in routingengineservice_db.provider_health_snapshot so it
// survives restarts. Counters are bumped synchronously from POST /api/checkout
// so failover-on-outage is observable within the next request (≪ 5s).

import { rows } from "@/lib/pg";

const THRESHOLD = Number(process.env.CIRCUIT_THRESHOLD ?? 3);
const COOLDOWN_SECONDS = Number(
  process.env.CIRCUIT_COOLDOWN_S ?? (process.env.NODE_ENV === "production" ? 300 : 60),
);

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface ProviderCircuit {
  provider_code: string;
  circuit_state: CircuitState;
  consecutive_failures: number;
  circuit_opened_at: string | null;
  last_failure_at: string | null;
  last_success_at: string | null;
}

// Promote OPEN → HALF_OPEN once cooldown has elapsed. Called from getCircuit.
function maybePromote(c: ProviderCircuit): ProviderCircuit {
  if (c.circuit_state === "OPEN" && c.circuit_opened_at) {
    const opened = new Date(c.circuit_opened_at).getTime();
    if (Date.now() - opened >= COOLDOWN_SECONDS * 1000) {
      return { ...c, circuit_state: "HALF_OPEN" };
    }
  }
  return c;
}

export async function getCircuit(provider: string): Promise<ProviderCircuit | null> {
  const r = await rows<ProviderCircuit>("routingEngine", `
    SELECT provider_code, circuit_state, consecutive_failures,
           circuit_opened_at, last_failure_at, last_success_at
      FROM provider_health_snapshot WHERE provider_code = $1
  `, [provider.toUpperCase()]).catch(() => []);
  if (!r[0]) return null;
  const promoted = maybePromote(r[0]);
  if (promoted.circuit_state !== r[0].circuit_state) {
    // Persist the auto-promotion so other workers see HALF_OPEN.
    await rows("routingEngine", `
      UPDATE provider_health_snapshot SET circuit_state='HALF_OPEN'
       WHERE provider_code=$1 AND circuit_state='OPEN'
    `, [r[0].provider_code]).catch(() => {});
  }
  return promoted;
}

// Provider is open-circuit if state is OPEN. HALF_OPEN providers are eligible
// (one probe). CLOSED providers are eligible.
export function isOpenCircuit(c: ProviderCircuit | null): boolean {
  return !!c && c.circuit_state === "OPEN";
}

export async function recordSuccess(provider: string): Promise<void> {
  await rows("routingEngine", `
    UPDATE provider_health_snapshot
       SET circuit_state='CLOSED',
           consecutive_failures=0,
           circuit_opened_at=NULL,
           half_open_at=CASE WHEN circuit_state='HALF_OPEN' THEN now() ELSE half_open_at END,
           last_success_at=now(),
           updated_at=now()
     WHERE provider_code=$1
  `, [provider.toUpperCase()]).catch(() => {});
}

export async function recordFailure(provider: string): Promise<{ tripped: boolean; state: CircuitState }> {
  const upd = await rows<{ circuit_state: CircuitState; consecutive_failures: number }>("routingEngine", `
    UPDATE provider_health_snapshot
       SET consecutive_failures = consecutive_failures + 1,
           last_failure_at = now(),
           circuit_state = CASE
             WHEN consecutive_failures + 1 >= $2 THEN 'OPEN'
             WHEN circuit_state = 'HALF_OPEN' THEN 'OPEN'
             ELSE circuit_state
           END,
           circuit_opened_at = CASE
             WHEN consecutive_failures + 1 >= $2 OR circuit_state = 'HALF_OPEN'
             THEN COALESCE(circuit_opened_at, now())
             ELSE circuit_opened_at
           END,
           updated_at=now()
     WHERE provider_code=$1
     RETURNING circuit_state, consecutive_failures
  `, [provider.toUpperCase(), THRESHOLD]).catch(() => []);
  if (!upd.length) return { tripped: false, state: "CLOSED" };
  const tripped = upd[0].circuit_state === "OPEN" && upd[0].consecutive_failures >= THRESHOLD;
  return { tripped, state: upd[0].circuit_state };
}

export async function resetCircuit(provider: string): Promise<void> {
  await rows("routingEngine", `
    UPDATE provider_health_snapshot
       SET circuit_state='CLOSED', consecutive_failures=0,
           circuit_opened_at=NULL, half_open_at=NULL, updated_at=now()
     WHERE provider_code=$1
  `, [provider.toUpperCase()]).catch(() => {});
}

export function config() {
  return { threshold: THRESHOLD, cooldown_seconds: COOLDOWN_SECONDS };
}
