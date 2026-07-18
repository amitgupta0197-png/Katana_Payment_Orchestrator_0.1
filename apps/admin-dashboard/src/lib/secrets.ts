// Fail-closed secret resolution (security audit C1/C4/H2/H3/H8).
//
// Several secrets historically fell back to a committed dev-default when their env var was
// unset (SESSION_SECRET, FIFO_WEBHOOK_SECRET, PG_PASSWORD, the vendor webhook secret). A
// production process running on a known-public value means forgeable sessions, forgeable
// device/webhook signatures, and a known DB password. `requireSecret` refuses to hand back a
// missing or known-default value in production — the app fails to boot instead of running
// insecure. In development it still returns a dev fallback so local setup needs no config.
//
// DEPLOY NOTE: because these throw at module load, the real secrets must be set in the
// environment BEFORE code using them is deployed to production. Rotate first, then deploy.

const IS_PROD = process.env.NODE_ENV === "production";

// Values that must never authenticate anything in production — the committed dev defaults.
const KNOWN_DEFAULTS = new Set([
  "dev-session-secret-do-not-use-in-prod",
  "dev-webhook-secret",
  "sandbox-secret-do-not-use-in-prod",
  "sixsenai_pg_2024_secure",
  "demo",
  "changeme",
]);

/**
 * Return `value` when it is a real (non-default) secret. In production, throw if it is unset
 * or a known default. In non-production, fall back to `devFallback` so local dev just works.
 */
export function requireSecret(name: string, value: string | undefined | null, devFallback: string): string {
  if (value && !KNOWN_DEFAULTS.has(value)) return value;
  if (!IS_PROD) return value || devFallback;
  throw new Error(
    `${name} is unset or set to a known insecure default. Refusing to start in production — ` +
    `set a strong unique value (rotate it first, then deploy). See docs/SECURITY-AUDIT-2026-07.md.`,
  );
}
