// Credential vault (BRD §15: "Encrypt MID keys, API secrets, webhook secrets
// and bank credentials with key rotation").
//
// AES-256-GCM envelope encryption. Master key supplied via env
// (VAULT_MASTER_KEY = base64(32 bytes)); production swaps to KMS or HSM and
// the helper API stays identical.
//
// Roles:
//   sealValue(plaintext)  → { iv, auth_tag, ciphertext }
//   unsealValue(record)   → plaintext (Buffer)
//   storeCredential(...)  → row id, returns no plaintext
//   readCredential(...)   → plaintext string

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import type { PoolClient } from "pg";
import { rows } from "@/lib/pg";

const KEY_VERSION = 1;

function masterKey(): Buffer {
  const env = process.env.VAULT_MASTER_KEY;
  if (env) {
    const k = Buffer.from(env, "base64");
    if (k.length !== 32) throw new Error("VAULT_MASTER_KEY must decode to 32 bytes");
    return k;
  }
  // Production MUST supply a real key. Without it every sealed secret would be encrypted
  // under the public 0x42 constant (audit C4) — refuse to run. Rotate the vault with
  // tools/reseal-vault.mjs before setting VAULT_MASTER_KEY for the first time.
  if (process.env.NODE_ENV === "production")
    throw new Error("VAULT_MASTER_KEY is required in production (base64 32 bytes). See docs/SECURITY-AUDIT-2026-07.md.");
  // Dev-only deterministic key so the demo runs without setup.
  // 32 bytes of repeated 0x42 — easy to spot in dumps and clearly not prod.
  return Buffer.alloc(32, 0x42);
}

export interface SealedBlob {
  iv: Buffer;          // 12 bytes
  auth_tag: Buffer;    // 16 bytes
  ciphertext: Buffer;
}

export function sealValue(plaintext: string | Buffer): SealedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const pt = typeof plaintext === "string" ? Buffer.from(plaintext, "utf-8") : plaintext;
  const ciphertext = Buffer.concat([cipher.update(pt), cipher.final()]);
  return { iv, auth_tag: cipher.getAuthTag(), ciphertext };
}

export function unsealValue(blob: SealedBlob): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), blob.iv);
  decipher.setAuthTag(blob.auth_tag);
  return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
}

export interface StoreInput {
  kind: "vendor_secret" | "mid_secret" | "webhook_secret" | "bank_key" | "merchant_secret";
  ownerType: "vendor" | "merchant" | "provider" | "tenant";
  ownerId: string;
  label: string;
  plaintext: string;
}

// `client` stores the credential inside the caller's own transaction on checkoutservice_db, so a
// rotation can replace the sealed secret and its lookup row atomically (issueCheckoutCreds).
export async function storeCredential(input: StoreInput, client?: PoolClient): Promise<string> {
  const sealed = sealValue(input.plaintext);
  const sql = `
    INSERT INTO credential_vault
      (kind, owner_type, owner_id, label, iv, auth_tag, ciphertext, key_version)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (kind, owner_type, owner_id, label, key_version) DO UPDATE
      SET iv=EXCLUDED.iv, auth_tag=EXCLUDED.auth_tag,
          ciphertext=EXCLUDED.ciphertext, rotated_at=now()
    RETURNING credential_id::text
  `;
  const params = [input.kind, input.ownerType, input.ownerId, input.label,
    sealed.iv, sealed.auth_tag, sealed.ciphertext, KEY_VERSION];
  const r = client
    ? (await client.query<{ credential_id: string }>(sql, params)).rows
    : await rows<{ credential_id: string }>("checkout", sql, params);
  return r[0].credential_id;
}

export async function readCredential(input: {
  kind: StoreInput["kind"]; ownerType: StoreInput["ownerType"];
  ownerId: string; label: string;
}): Promise<string | null> {
  const r = await rows<any>("checkout", `
    SELECT iv, auth_tag, ciphertext FROM credential_vault
     WHERE kind=$1 AND owner_type=$2 AND owner_id=$3 AND label=$4 AND enabled=true
     ORDER BY key_version DESC LIMIT 1
  `, [input.kind, input.ownerType, input.ownerId, input.label]).catch(() => []);
  if (!r.length) return null;
  // pg returns bytea as Buffer.
  const plaintext = unsealValue({
    iv: r[0].iv, auth_tag: r[0].auth_tag, ciphertext: r[0].ciphertext,
  });
  return plaintext.toString("utf-8");
}

export async function listCredentials(filter: { ownerType?: string; ownerId?: string } = {}) {
  const where: string[] = ["enabled = true"];
  const params: unknown[] = [];
  if (filter.ownerType) { params.push(filter.ownerType); where.push(`owner_type = $${params.length}`); }
  if (filter.ownerId)   { params.push(filter.ownerId);   where.push(`owner_id = $${params.length}`); }
  return rows<any>("checkout", `
    SELECT credential_id::text, kind, owner_type, owner_id, label,
           key_version, enabled, created_at, rotated_at,
           COALESCE(rotated_by,'') AS rotated_by
      FROM credential_vault
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC LIMIT 200
  `, params);
}
