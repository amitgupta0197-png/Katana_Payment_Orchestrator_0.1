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
//   • CALLBACK routes (vendor gateways) always send a real signature; only
//     the in-house tester ever used x-sandbox. `sandboxAllowed()` closes the bypass in
//     production unconditionally — safe to deploy now.
//
//   • DEVICE routes cannot close the bypass until the agent is rebuilt to sign. Until then,
//     `deviceSandboxAllowed()` keeps x-sandbox working in production ONLY when the operator
//     explicitly opts in with LEGACY_SANDBOX_AGENTS=1. Default is closed. Once the signed
//     agent is rolled out to the fleet, remove that env var to shut the bypass for good.

import { createHmac, timingSafeEqual } from "crypto";
import { requireSecret } from "@/lib/secrets";
import { deviceKey, touchDeviceKey, verifyDeviceSignature } from "@/lib/device-keys";
import { recordSecurityEvent } from "@/lib/security-event";

// The key shared by every agent before v3.11 — distinct from FIFO_WEBHOOK_SECRET (which signs
// OUTBOUND merchant callbacks), so extracting it from the APK does not also forge outbound
// callbacks (audit H2/C3). Being in a public APK, it authenticates nobody in particular: see
// verifyDeviceRequest. Resolved lazily so callback routes that import this module don't require it.
let _agentSecret: string | null = null;
function agentSecret(): string {
  if (_agentSecret === null)
    _agentSecret = requireSecret("AGENT_SIGNING_SECRET", process.env.AGENT_SIGNING_SECRET, "dev-agent-signing-secret");
  return _agentSecret;
}

const REPLAY_SKEW_MS = 5 * 60 * 1000; // ±5 min

/** HMAC-SHA256 over `${timestamp}.${payload}` — the timestamp is INSIDE the signature so a
 *  captured request cannot be replayed with a fresh timestamp (audit M2). Hex output. */
export function deviceSignature(timestamp: string, payload: string): string {
  return createHmac("sha256", agentSecret()).update(`${timestamp}.${payload}`).digest("hex");
}

export type DeviceAuth =
  | { ok: true; deviceId: string | null; keyed: boolean }
  | { ok: false; error: string };

/** The agent's shared key is still accepted unless AGENT_SHARED_KEY_ACCEPTED=0. */
export function sharedKeyAccepted(): boolean {
  return process.env.AGENT_SHARED_KEY_ACCEPTED !== "0";
}

/** What the phone's own key signs: its device id, the timestamp and the payload. */
export function deviceSigningString(deviceId: string, timestamp: string, payload: string): string {
  return `${deviceId}.${timestamp}.${payload}`;
}

// The device id a request says it is from: `device_id` in the JSON body, or in the query
// string for the capture-rrn GET.
function claimedDeviceId(payload: string): string | null {
  if (payload.startsWith("?")) return new URLSearchParams(payload).get("device_id") || null;
  try {
    const v = (JSON.parse(payload) as { device_id?: unknown })?.device_id;
    return typeof v === "string" && v ? v : null;
  } catch { return null; }
}

/**
 * Verify a device request. `payload` is the exact bytes the agent signed — the raw body for
 * POST routes, or the query string (`url.search`) for the capture-rrn GET.
 *
 * TWO SIGNATURES, DURING THE MOVE FROM ONE TO THE OTHER.
 *
 *   x-device-id + x-device-signature   the phone's own key (agent v3.11+, lib/device-keys.ts).
 *       Proves which phone sent it. The device id in the payload must be the same one.
 *   x-signature                        the key shared by every agent before that. It is in the
 *       public APK, so it proves only that the sender has seen the APK. Still accepted for a
 *       phone that has not enrolled a key, because the fleet cannot be updated in one moment;
 *       refused for a phone that has, and refused for everyone once AGENT_SHARED_KEY_ACCEPTED=0.
 *
 * Also honours the x-sandbox transition bypass on device routes (LEGACY_SANDBOX_AGENTS).
 */
export async function verifyDeviceRequest(req: Request, payload: string): Promise<DeviceAuth> {
  const claimed = claimedDeviceId(payload);
  if (deviceSandboxRequested(req)) return { ok: true, deviceId: claimed, keyed: false };
  const ts = req.headers.get("x-timestamp");
  const ownSig = req.headers.get("x-device-signature");
  const sig = req.headers.get("x-signature");
  if (!ts || !(ownSig || sig)) return { ok: false, error: "missing signature/timestamp" };
  const tsNum = Number(ts);
  if (Number.isNaN(tsNum)) return { ok: false, error: "bad timestamp" };
  const tsMs = tsNum > 1e12 ? tsNum : tsNum * 1000; // accept seconds or millis
  if (Math.abs(Date.now() - tsMs) > REPLAY_SKEW_MS) return { ok: false, error: "stale timestamp (replay window exceeded)" };

  if (ownSig) {
    // Header values are ASCII and a device id need not be, so the agent sends it percent-encoded.
    let deviceId = "";
    try { deviceId = decodeURIComponent(req.headers.get("x-device-id") ?? ""); } catch { /* refused below */ }
    if (!deviceId) return { ok: false, error: "missing device id" };
    if (claimed && claimed !== deviceId) return { ok: false, error: "device id does not match the signing device" };
    const key = await deviceKey(deviceId);
    if (key) {
      if (!verifyDeviceSignature(key.public_key, deviceSigningString(deviceId, ts, payload), ownSig))
        return { ok: false, error: "invalid signature" };
      touchDeviceKey(deviceId);
      return { ok: true, deviceId, keyed: true };
    }
    // Not enrolled (yet, or its key was reset): the request stands or falls on the shared key.
  }

  if (!sig || !sharedKeyAccepted()) return { ok: false, error: "this device has no enrolled key" };
  if (!sigEqual(deviceSignature(ts, payload), sig)) return { ok: false, error: "invalid signature" };
  // A phone that has its own key never needs the shared one again. A request that names such
  // a phone and carries only the shared signature did not come from it.
  if (claimed && await deviceKey(claimed)) {
    void recordSecurityEvent({
      risk: "DEVICE_KEY", severity: "HIGH",
      detail: `A request naming device "${claimed}" was signed with the shared agent key, but that phone signs with its own key. Refused.`,
    });
    return { ok: false, error: "this device signs with its own key" };
  }
  return { ok: true, deviceId: claimed, keyed: false };
}

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
