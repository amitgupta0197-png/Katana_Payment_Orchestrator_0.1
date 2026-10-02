// A secret held in an ordinary text column, encrypted at rest with the vault's master key
// (lib/credential-vault: AES-256-GCM, VAULT_MASTER_KEY).
//
// For secrets that live beside the row they belong to: a merchant's webhook signing secret, a
// mailbox's app password or refresh token, a user's TOTP secret. A sealed value is the text
//
//   enc:v1:<base64 of iv | auth tag | ciphertext>
//
// openText() also accepts a value with no such prefix and returns it as it is: the rows written
// before this existed are plaintext, and they keep working until they are sealed
// (POST /api/admin/secrets/seal sealPlaintextSecrets below). Nothing has to be migrated in one step.

import { rows, type DbKey } from "@/lib/pg";
import { sealValue, unsealValue } from "@/lib/credential-vault";

const PREFIX = "enc:v1:";

export function isSealed(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(PREFIX);
}

export function sealText(plaintext: string): string {
  const b = sealValue(plaintext);
  return PREFIX + Buffer.concat([b.iv, b.auth_tag, b.ciphertext]).toString("base64");
}

/** The secret a stored value holds: unsealed when it is sealed, as it is when it is not. */
export function openText(stored: string): string;
export function openText(stored: string | null | undefined): string | null;
export function openText(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  if (!stored.startsWith(PREFIX)) return stored;
  const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
  return unsealValue({ iv: raw.subarray(0, 12), auth_tag: raw.subarray(12, 28), ciphertext: raw.subarray(28) }).toString("utf-8");
}

// Every column that holds a secret this way: database, table, its key column, the secret column.
export const SEALED_COLUMNS: { db: DbKey; table: string; key: string; column: string }[] = [
  { db: "notification", table: "merchant_webhook_configs", key: "config_id", column: "secret" },
  { db: "vendorGateway", table: "vendor_email_inboxes", key: "email", column: "app_password" },
  { db: "vendorGateway", table: "vendor_email_inboxes", key: "email", column: "refresh_token" },
  { db: "fifo", table: "fifo_user_mfa", key: "email", column: "totp_secret" },
];

/**
 * Seal every value in those columns that is still plaintext. Safe to run again: a sealed value
 * is skipped, and each row is only written if it still holds the plaintext that was read.
 */
export async function sealPlaintextSecrets(): Promise<{ table: string; column: string; sealed: number; already: number }[]> {
  const out = [];
  for (const c of SEALED_COLUMNS) {
    const all = await rows<{ k: string; v: string }>(c.db,
      `SELECT ${c.key}::text AS k, ${c.column} AS v FROM ${c.table} WHERE ${c.column} IS NOT NULL AND ${c.column} <> ''`);
    let sealed = 0;
    for (const r of all.filter((x) => !isSealed(x.v))) {
      const done = await rows(c.db,
        `UPDATE ${c.table} SET ${c.column} = $1 WHERE ${c.key}::text = $2 AND ${c.column} = $3 RETURNING 1`,
        [sealText(r.v), r.k, r.v]);
      sealed += done.length;
    }
    out.push({ table: c.table, column: c.column, sealed, already: all.filter((x) => isSealed(x.v)).length });
  }
  return out;
}
