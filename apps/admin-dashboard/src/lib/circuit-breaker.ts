// Per-provider circuit breaker (BRD §6 P2 acceptance:
// "Merchant outage triggers failover within 5 seconds").
//
//   CLOSED      → request flows normally
//   OPEN        → all requests skip this provider (treated as kill-switched)
//   HALF_OPEN   → one request is let through as the probe (claimProbe); success → CLOSED,
//                 failure → OPEN and the cool-off starts again
//
// Trip rules (env-tunable):
//   THRESHOLD   = 5 consecutive failures  → trip to OPEN
//   COOLDOWN_S  = 60s (dev) / 180s (prod) → after which OPEN → HALF_OPEN
//
// The state lives in routingengineservice_db.provider_health_snapshot so it
// survives restarts. Counters are bumped synchronously from POST /api/checkout
// so failover-on-outage is observable within the next request (≪ 5s).
//
// Every change of state is written to circuit_breaker_events (routingEngine 0004), and a trip
// or a failed probe is sent to the admin Telegram chats (lib/ops-alert).
//
// A provider is matched whatever the case of its code: the rows are seeded lowercase and the
// callers pass either.

import { rows } from "@/lib/pg";
import { raiseAlert, resolveAlert } from "@/lib/ops-alert";

const THRESHOLD = Number(process.env.CIRCUIT_THRESHOLD ?? 5);
const COOLDOWN_SECONDS = Number(
  process.env.CIRCUIT_COOLDOWN_S ?? (process.env.NODE_ENV === "production" ? 180 : 60),
);

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";
export type CircuitEvent = "TRIPPED" | "HALF_OPEN" | "PROBE_FAILED" | "RECOVERED" | "RESET";

export interface ProviderCircuit {
  provider_code: string;
  circuit_state: CircuitState;
  consecutive_failures: number;
  circuit_opened_at: string | null;
  last_failure_at: string | null;
  last_success_at: string | null;
}

const alertKey = (provider: string) => `circuit:${provider.toUpperCase()}`;

/** Record a change of state. Best-effort: the breaker works without its log. */
export async function logCircuitEvent(e: {
  provider: string; event: CircuitEvent; from: CircuitState | null; to: CircuitState; failures?: number | null; actor?: string;
}): Promise<void> {
  await rows("routingEngine", `
    INSERT INTO circuit_breaker_events (provider_code, event, from_state, to_state, consecutive_failures, actor)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [e.provider.toUpperCase(), e.event, e.from, e.to, e.failures ?? null, e.actor ?? "system"]).catch(() => {});
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
      FROM provider_health_snapshot WHERE upper(provider_code) = $1
  `, [provider.toUpperCase()]).catch(() => []);
  if (!r[0]) return null;
  const promoted = maybePromote(r[0]);
  if (promoted.circuit_state !== r[0].circuit_state) {
    // Persist the auto-promotion so other workers see HALF_OPEN. Only the read that makes the
    // change logs it.
    const moved = await rows("routingEngine", `
      UPDATE provider_health_snapshot SET circuit_state='HALF_OPEN'
       WHERE provider_code=$1 AND circuit_state='OPEN' RETURNING provider_code
    `, [r[0].provider_code]).catch(() => []);
    if (moved.length)
      await logCircuitEvent({ provider, event: "HALF_OPEN", from: "OPEN", to: "HALF_OPEN", failures: r[0].consecutive_failures });
  }
  return promoted;
}

// Provider is open-circuit if state is OPEN. HALF_OPEN providers are eligible
// (probing). CLOSED providers are eligible.
export function isOpenCircuit(c: ProviderCircuit | null): boolean {
  return !!c && c.circuit_state === "OPEN";
}

// How long one probe holds the HALF_OPEN circuit before another may be sent. A probe that
// never reports back (a crashed request) must not hold the circuit half-open for ever.
const PROBE_HOLD_SECONDS = 30;

/**
 * Claim the probe of a HALF_OPEN circuit. Exactly one caller gets it; the rest are told the
 * provider is unavailable until the probe reports (recordSuccess / recordFailure) or its hold
 * runs out. half_open_at is the time of the claim: one made before the circuit last opened
 * belongs to an earlier cycle and does not count.
 */
export async function claimProbe(provider: string): Promise<boolean> {
  const r = await rows("routingEngine", `
    UPDATE provider_health_snapshot
       SET half_open_at = now()
     WHERE upper(provider_code) = $1 AND circuit_state = 'HALF_OPEN'
       AND (half_open_at IS NULL
            OR half_open_at < COALESCE(circuit_opened_at, half_open_at)
            OR half_open_at < now() - make_interval(secs => $2))
    RETURNING provider_code
  `, [provider.toUpperCase(), PROBE_HOLD_SECONDS]).catch(() => []);
  return r.length > 0;
}

export async function recordSuccess(provider: string): Promise<void> {
  const upd = await rows<{ prev_state: CircuitState }>("routingEngine", `
    WITH prev AS (
      SELECT provider_code, circuit_state FROM provider_health_snapshot
       WHERE upper(provider_code) = $1 FOR UPDATE
    )
    UPDATE provider_health_snapshot h
       SET circuit_state='CLOSED',
           consecutive_failures=0,
           circuit_opened_at=NULL,
           half_open_at=NULL,
           last_success_at=now(),
           updated_at=now()
      FROM prev
     WHERE h.provider_code = prev.provider_code
    RETURNING prev.circuit_state AS prev_state
  `, [provider.toUpperCase()]).catch(() => []);
  const prev = upd[0]?.prev_state;
  if (prev && prev !== "CLOSED") {
    await logCircuitEvent({ provider, event: "RECOVERED", from: prev, to: "CLOSED", failures: 0 });
    void resolveAlert(alertKey(provider), "A payment went through; the circuit is closed again.");
  }
}

export async function recordFailure(provider: string): Promise<{ tripped: boolean; state: CircuitState }> {
  const upd = await rows<{ circuit_state: CircuitState; consecutive_failures: number; prev_state: CircuitState }>("routingEngine", `
    WITH prev AS (
      SELECT provider_code, circuit_state FROM provider_health_snapshot
       WHERE upper(provider_code) = $1 FOR UPDATE
    )
    UPDATE provider_health_snapshot h
       SET consecutive_failures = h.consecutive_failures + 1,
           last_failure_at = now(),
           circuit_state = CASE
             WHEN h.consecutive_failures + 1 >= $2 THEN 'OPEN'
             WHEN h.circuit_state = 'HALF_OPEN' THEN 'OPEN'
             ELSE h.circuit_state
           END,
           -- A failed probe starts the cool-off again. Keeping the first trip's time here would
           -- leave it already elapsed, and the next read would reopen the probe at once.
           circuit_opened_at = CASE
             WHEN h.circuit_state = 'HALF_OPEN' THEN now()
             WHEN h.consecutive_failures + 1 >= $2 AND h.circuit_state <> 'OPEN' THEN now()
             ELSE h.circuit_opened_at
           END,
           updated_at=now()
      FROM prev
     WHERE h.provider_code = prev.provider_code
     RETURNING h.circuit_state, h.consecutive_failures, prev.circuit_state AS prev_state
  `, [provider.toUpperCase(), THRESHOLD]).catch(() => []);
  if (!upd.length) return { tripped: false, state: "CLOSED" };
  const { circuit_state: state, consecutive_failures: failures, prev_state: prev } = upd[0];
  const tripped = state === "OPEN" && prev !== "OPEN";
  if (tripped) {
    const probe = prev === "HALF_OPEN";
    await logCircuitEvent({ provider, event: probe ? "PROBE_FAILED" : "TRIPPED", from: prev, to: "OPEN", failures });
    void raiseAlert({
      key: alertKey(provider), severity: "CRITICAL",
      title: `Circuit OPEN: ${provider.toUpperCase()}`,
      body: probe
        ? `The probe after the cool-off failed. Traffic stays off it for another ${COOLDOWN_SECONDS}s.`
        : `${failures} failures in a row. Traffic is off it for ${COOLDOWN_SECONDS}s, then one probe.`,
    });
  }
  return { tripped, state };
}

export async function resetCircuit(provider: string, actor = "operator"): Promise<void> {
  const upd = await rows<{ prev_state: CircuitState }>("routingEngine", `
    WITH prev AS (
      SELECT provider_code, circuit_state FROM provider_health_snapshot
       WHERE upper(provider_code) = $1 FOR UPDATE
    )
    UPDATE provider_health_snapshot h
       SET circuit_state='CLOSED', consecutive_failures=0,
           circuit_opened_at=NULL, half_open_at=NULL, updated_at=now()
      FROM prev
     WHERE h.provider_code = prev.provider_code
    RETURNING prev.circuit_state AS prev_state
  `, [provider.toUpperCase()]).catch(() => []);
  if (!upd.length) return;
  await logCircuitEvent({ provider, event: "RESET", from: upd[0].prev_state, to: "CLOSED", failures: 0, actor });
  void resolveAlert(alertKey(provider), `Reset by ${actor}.`);
}

/** Providers whose circuit is not closed, for the monitor and the metrics. */
export async function circuitStates(): Promise<{ provider_code: string; circuit_state: CircuitState; consecutive_failures: number }[]> {
  return rows<{ provider_code: string; circuit_state: CircuitState; consecutive_failures: number }>("routingEngine", `
    SELECT upper(provider_code) AS provider_code, circuit_state, consecutive_failures
      FROM provider_health_snapshot ORDER BY 1
  `).catch(() => []);
}

export function config() {
  return { threshold: THRESHOLD, cooldown_seconds: COOLDOWN_SECONDS };
}
