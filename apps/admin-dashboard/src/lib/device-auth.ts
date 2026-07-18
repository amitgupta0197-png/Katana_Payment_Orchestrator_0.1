// Device / callback auth helpers (security hardening 2026-07).
//
// The device-ingestion + vendor-callback routes historically let a request skip all
// signature/timestamp checks by sending `x-sandbox: 1`. That header is attacker-supplied,
// so honouring it in production turns those public endpoints into unauthenticated
// payment-forgery paths (audit C2). This module gates the bypass.
//
// IMPORTANT MIGRATION NOTE: the deployed Android agent authenticates to the DEVICE routes
// (txn-alert, heartbeat, capture-rrn, email-config, agent-debug) using `x-sandbox: 1` — it
// does NOT yet sign its requests. So we split the gate in two:
//
//   • CALLBACK routes (real PoolPay / vendor gateways) always send a real signature; only
//     the in-house tester ever used x-sandbox. `sandboxAllowed()` closes the bypass in
//     production unconditionally — safe to deploy now.
//
//   • DEVICE routes cannot close the bypass until the agent is rebuilt to sign. Until then,
//     `deviceSandboxAllowed()` keeps x-sandbox working in production ONLY when the operator
//     explicitly opts in with LEGACY_SANDBOX_AGENTS=1. Default is closed. Once the signed
//     agent is rolled out to the fleet, remove that env var to shut the bypass for good.

import { timingSafeEqual } from "crypto";

/** x-sandbox bypass for CALLBACK routes / anything not hit by the live agent. Never in prod. */
export function sandboxAllowed(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.ALLOW_SANDBOX_AUTH === "1";
}

/**
 * x-sandbox bypass for DEVICE routes the deployed agent still calls with x-sandbox.
 * Permitted in non-prod (opt-in), or in prod only during the agent-signing migration
 * (LEGACY_SANDBOX_AGENTS=1). Remove that env once the signed agent is deployed fleet-wide.
 */
export function deviceSandboxAllowed(): boolean {
  if (process.env.NODE_ENV !== "production") return process.env.ALLOW_SANDBOX_AUTH === "1";
  return process.env.LEGACY_SANDBOX_AGENTS === "1";
}

/** True when a request presents `x-sandbox: 1` AND the environment permits it (callback tier). */
export function sandboxRequested(req: Request): boolean {
  return req.headers.get("x-sandbox") === "1" && sandboxAllowed();
}

/** True when a request presents `x-sandbox: 1` AND the environment permits it (device tier). */
export function deviceSandboxRequested(req: Request): boolean {
  return req.headers.get("x-sandbox") === "1" && deviceSandboxAllowed();
}

/** Constant-time comparison of two hex signature strings (avoids a timing oracle). */
export function sigEqual(expected: string, got: string | null | undefined): boolean {
  if (!got) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
