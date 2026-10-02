// A capture phone's own signing key (vendorGateway 0037).
//
// The agent makes an EC P-256 key pair on the phone and enrols the public half; from then on
// it signs every request with the private half, which never leaves the phone. The server
// holds nothing secret. lib/device-auth.ts checks the signatures; this file keeps the keys.

import { createPublicKey, verify, type KeyObject } from "crypto";
import { rows } from "@/lib/pg";

export interface DeviceKey { device_id: string; public_key: string; install_id: string | null; enrolled_at: string }

// Read on every device request, so held briefly in memory. Single instance: an enrolment or a
// reset here takes effect at once.
const cache = new Map<string, { key: DeviceKey | null; at: number }>();
const TTL_MS = 30_000;

export async function deviceKey(deviceId: string): Promise<DeviceKey | null> {
  const hit = cache.get(deviceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.key;
  // A database without the table (0037 not applied) has no keys; that must not stop the phones.
  const key = (await rows<DeviceKey>("vendorGateway",
    `SELECT device_id, public_key, install_id, enrolled_at FROM vendor_device_keys WHERE device_id = $1`, [deviceId])
    .catch((err) => { if ((err as { code?: string }).code === "42P01") return [] as DeviceKey[]; throw err; }))[0] ?? null;
  cache.set(deviceId, { key, at: Date.now() });
  return key;
}

/** The key as Node reads it, or null when it is not an EC P-256 public key. */
export function parsePublicKey(publicKeyB64: string): KeyObject | null {
  try {
    const k = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return k.asymmetricKeyType === "ec" && k.asymmetricKeyDetails?.namedCurve === "prime256v1" ? k : null;
  } catch { return null; }
}

/** True when `signatureB64` (ECDSA, DER, as Android produces it) is this key's signature of `data`. */
export function verifyDeviceSignature(publicKeyB64: string, data: string, signatureB64: string): boolean {
  const key = parsePublicKey(publicKeyB64);
  if (!key) return false;
  try { return verify("sha256", Buffer.from(data, "utf8"), key, Buffer.from(signatureB64, "base64")); }
  catch { return false; }
}

export type EnrolResult =
  | { ok: true; enrolled: "new" | "same" }
  | { ok: false; code: "BAD_KEY" | "KEY_CONFLICT" | "INSTALL_MISMATCH"; error: string };

/**
 * Keep the first key a device id presents.
 *
 * A device the server already knows is only given a key by a request that also carries the
 * install id its heartbeats have been sending: the device id is typed and shown, the install
 * id is neither, so knowing a trusted phone's name is not enough to enrol as it. A second,
 * different key for the same device id is refused: a reinstall makes a new key, and so does
 * an impostor, and only a person can tell which (resetDeviceKey, from the device registry).
 */
export async function enrolDeviceKey(input: { deviceId: string; installId: string | null; publicKey: string; hardwareBacked?: boolean | null }): Promise<EnrolResult> {
  if (!parsePublicKey(input.publicKey)) return { ok: false, code: "BAD_KEY", error: "public_key is not an EC P-256 key" };

  const known = (await rows<{ install_id: string | null }>("vendorGateway",
    `SELECT install_id FROM vendor_devices WHERE device_id = $1`, [input.deviceId]))[0];
  if (known?.install_id && known.install_id !== input.installId)
    return { ok: false, code: "INSTALL_MISMATCH", error: "this device id belongs to another phone" };

  const ins = await rows("vendorGateway", `
    INSERT INTO vendor_device_keys (device_id, public_key, install_id, hardware_backed)
    VALUES ($1, $2, $3, $4) ON CONFLICT (device_id) DO NOTHING RETURNING 1
  `, [input.deviceId, input.publicKey, input.installId, input.hardwareBacked ?? null]);
  cache.delete(input.deviceId);
  if (ins.length) return { ok: true, enrolled: "new" };

  const existing = await deviceKey(input.deviceId);
  if (existing?.public_key === input.publicKey) return { ok: true, enrolled: "same" };
  return { ok: false, code: "KEY_CONFLICT", error: "this device id already has a different key; ask support to reset it" };
}

/** Forget a device's key so the phone can enrol a new one (after a reinstall). Staff only. */
export async function resetDeviceKey(deviceId: string): Promise<boolean> {
  const r = await rows("vendorGateway", `DELETE FROM vendor_device_keys WHERE device_id = $1 RETURNING 1`, [deviceId]);
  cache.delete(deviceId);
  return r.length > 0;
}

export function touchDeviceKey(deviceId: string): void {
  void rows("vendorGateway",
    `UPDATE vendor_device_keys SET last_used_at = now() WHERE device_id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`,
    [deviceId]).catch(() => {});
}
