// API keys for the v2 order API (auth 0002).
//
// A v2 request carries `Authorization: Bearer <key>`. The key belongs to one banker and one
// mode, and its prefix says which: sk_live_… creates live orders, sk_test_… test orders. Only
// its SHA-256 is stored, so it is shown once, when it is made.
//
// ONLY THESE TWO PREFIXES ARE ACCEPTED. Keys issued before v2 are plain sk_… and were never a
// way to create an order; they stay as inert as they were.

import { createHash, randomBytes } from "crypto";
import { rows } from "@/lib/pg";
import { assertLiveActivated } from "@/lib/live-activation";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The mode a presented key claims, or null when it is not a v2 key. */
export function v2KeyMode(key: string): boolean | null {
  if (key.startsWith("sk_live_")) return true;
  if (key.startsWith("sk_test_")) return false;
  return null;
}

export interface V2KeyOwner { merchantCode: string; livemode: boolean; keyId: string; scopes: string[] }

/** The banker and mode behind a presented key, or null. Database errors propagate. */
export async function resolveV2Key(key: string): Promise<V2KeyOwner | null> {
  const mode = v2KeyMode(key);
  if (mode === null) return null;
  const r = await rows<{ id: string; owner_id: string; livemode: boolean; scopes: string[] | null }>("auth", `
    SELECT id::text, owner_id, livemode, scopes FROM api_keys
     WHERE secret_hash = $1 AND owner_kind = 'MERCHANT' AND status = 'ACTIVE' LIMIT 1
  `, [sha256(key)]);
  const k = r[0];
  // The stored mode and the prefix must agree, as on the Key + Salt pair.
  if (!k || k.livemode !== mode) return null;
  const m = await rows<{ merchant_code: string }>("merchant",
    `SELECT merchant_code FROM merchants WHERE merchant_code = $1 OR id::text = $1 LIMIT 1`, [k.owner_id]);
  if (!m.length) return null;
  void rows("auth",
    `UPDATE api_keys SET last_used_at = now() WHERE id = $1::uuid AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [k.id]).catch(() => {});
  return { merchantCode: m[0].merchant_code, livemode: mode, keyId: k.id, scopes: k.scopes ?? [] };
}

export interface V2KeyRow { id: string; label: string; prefix: string; livemode: boolean; status: string; created_at: string; last_used_at: string | null; revoked_at: string | null }

export async function listV2Keys(merchantCode: string): Promise<V2KeyRow[]> {
  return rows<V2KeyRow>("auth", `
    SELECT id::text, label, prefix, livemode, status, created_at, last_used_at, revoked_at FROM api_keys
     WHERE owner_kind = 'MERCHANT' AND owner_id = $1 AND (prefix LIKE 'sk_live_%' OR prefix LIKE 'sk_test_%')
     ORDER BY created_at DESC LIMIT 100
  `, [merchantCode]);
}

/** Make a key. A live key needs live mode activated for the banker; a test key never does. */
export async function issueV2Key(merchantCode: string, livemode: boolean, label: string, by: string): Promise<{ key: V2KeyRow; secret: string }> {
  if (livemode) await assertLiveActivated(merchantCode);
  const secret = `${livemode ? "sk_live_" : "sk_test_"}${randomBytes(24).toString("base64url")}`;
  const r = await rows<V2KeyRow>("auth", `
    INSERT INTO api_keys (tenant_id, owner_kind, owner_id, label, prefix, secret_hash, scopes, status, issued_by, livemode)
    VALUES ('tenant-default', 'MERCHANT', $1, $2, $3, $4, '{}'::text[], 'ACTIVE', $5, $6)
    RETURNING id::text, label, prefix, livemode, status, created_at, last_used_at, revoked_at
  `, [merchantCode, label.trim().slice(0, 120) || (livemode ? "Live key" : "Test key"), secret.slice(0, 12), sha256(secret), by, livemode]);
  return { key: r[0], secret };
}

export async function revokeV2Key(merchantCode: string, keyId: string): Promise<boolean> {
  const r = await rows("auth", `
    UPDATE api_keys SET status = 'REVOKED', revoked_at = now()
     WHERE id = $1::uuid AND owner_kind = 'MERCHANT' AND owner_id = $2 AND status = 'ACTIVE' RETURNING 1
  `, [keyId, merchantCode]);
  return r.length > 0;
}
