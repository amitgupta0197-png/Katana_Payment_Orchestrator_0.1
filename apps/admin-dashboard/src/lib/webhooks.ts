// Webhook reliability primitives (BRD §8 P4 contract).
//
//   idempotency_key = provider + provider_txn_id + event_type
//   payload_hash    = sha256(canonical_payload)
//   signature       = HMAC-SHA256(secret, payload_hash + "." + timestamp)
//   retry_policy    = 1m, 5m, 15m, 1h, 6h, 24h    →   move_to_dead_letter_queue
//
// canonicalise() sorts object keys recursively so the hash is order-stable
// regardless of what JSON the provider sent.

import { createHash, createHmac, timingSafeEqual } from "crypto";

// Replay window in seconds. Anything older than this is rejected even with
// a valid signature so an intercepted callback can't be replayed later.
export const REPLAY_WINDOW_SECONDS = 300;

// Retry schedule. Dev mode shrinks the early steps so demos don't wait an
// hour; prod uses the BRD-spec schedule verbatim.
const SCHEDULE_PROD = [60, 300, 900, 3600, 21600, 86400];           // 1m..24h
const SCHEDULE_DEV  = [5,  10,  30,  60,   120,   300];             // seconds
export function retrySchedule(): number[] {
  return process.env.NODE_ENV === "production" ? SCHEDULE_PROD : SCHEDULE_DEV;
}

export function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = canonicalise(obj[k]);
    return out;
  }
  return value;
}

export function payloadHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalise(body))).digest("hex");
}

export function dedupKey(vendor: string, providerTxnId: string, eventType: string): string {
  return [vendor.toUpperCase(), providerTxnId, eventType].join(":");
}

export function sign(secret: string, hash: string, timestamp: number | string): string {
  return createHmac("sha256", secret).update(`${hash}.${timestamp}`).digest("hex");
}

export function verifySignature(input: {
  secret: string;
  hash: string;
  timestamp: number | string;
  signature: string;
}): { ok: true } | { ok: false; reason: string } {
  // Timestamp check first — cheap and a common provider mistake.
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "non-numeric timestamp" };
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > REPLAY_WINDOW_SECONDS)
    return { ok: false, reason: `timestamp outside ±${REPLAY_WINDOW_SECONDS}s window (skew=${skew}s)` };

  const expected = sign(input.secret, input.hash, ts);
  let buf: Buffer; let exp: Buffer;
  try { buf = Buffer.from(input.signature, "hex"); exp = Buffer.from(expected, "hex"); }
  catch { return { ok: false, reason: "signature not hex" }; }
  if (buf.length !== exp.length) return { ok: false, reason: "signature length mismatch" };
  if (!timingSafeEqual(buf, exp)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

// Vendor secret lookup. In production this would hit the credential vault
// (BRD §3 KMS/HSM). For Sprint 3 demos we use a fixed env-overridable secret.
export function vendorSecret(vendor: string): string {
  const k = `VENDOR_SECRET_${vendor.toUpperCase()}`;
  return process.env[k] ?? process.env.VENDOR_SECRET_DEFAULT ?? "sandbox-secret-do-not-use-in-prod";
}
