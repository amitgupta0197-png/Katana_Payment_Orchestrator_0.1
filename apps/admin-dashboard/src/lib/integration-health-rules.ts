// The rule behind a banker's integration health (lib/integration-health): pure, no database.

export type HealthState = "OK" | "ATTENTION" | "FAILING" | "IDLE";

export interface BankerHealth {
  code: string;
  api: { requests: number; refused: number; last_at: string | null; last_error: string | null };
  callbacks: { delivered: number; retrying: number; failed: number; last_delivered_at: string | null; last_error: string | null };
  capture: { last_credit_at: string | null; today: number };
  state: HealthState;
  /** One plain sentence on what is wrong, or null when nothing is. */
  note: string | null;
}

export type Counts = Pick<BankerHealth, "api" | "callbacks">;

/** The state of one banker's integration, and the sentence a person reads. */
export function verdict(c: Counts): { state: HealthState; note: string | null } {
  const { api, callbacks: cb } = c;
  if (cb.failed > 0)
    return { state: "FAILING", note: `${cb.failed} payment message${cb.failed === 1 ? "" : "s"} could not reach your server${cb.last_error ? ` (${cb.last_error})` : ""}.` };
  if (api.requests >= 10 && api.refused / api.requests > 0.5)
    return { state: "FAILING", note: `Most API requests are refused${api.last_error ? ` (${api.last_error})` : ""}.` };
  if (cb.retrying > 0)
    return { state: "ATTENTION", note: `${cb.retrying} payment message${cb.retrying === 1 ? " is" : "s are"} being retried${cb.last_error ? ` (${cb.last_error})` : ""}.` };
  if (api.refused > 0)
    return { state: "ATTENTION", note: `${api.refused} API request${api.refused === 1 ? " was" : "s were"} refused${api.last_error ? ` (last: ${api.last_error})` : ""}.` };
  if (api.requests === 0 && cb.delivered === 0) return { state: "IDLE", note: null };
  return { state: "OK", note: null };
}
