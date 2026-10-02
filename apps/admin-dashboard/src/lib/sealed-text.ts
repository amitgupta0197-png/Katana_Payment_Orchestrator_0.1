// A secret held in an ordinary text column, encrypted at rest with the vault's master key
// (lib/credential-vault: AES-256-GCM, VAULT_MASTER_KEY).
//
// For secrets that live beside the row they belong to: a merchant's webhook signing secret, a
// mailbox's app password or refresh token, a user's TOTP secret, a bank account number. A sealed
// value is the text
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

/** sealText for a value that may be absent: null, undefined and "" are stored as they are. */
export function sealOptional(plaintext: string | null | undefined): string | null {
  return plaintext ? sealText(plaintext) : plaintext ?? null;
}

/**
 * A row whose jsonb column `column` holds a sealed value under `key`, with that value opened.
 * For a snapshot that carries a sealed field (a settlement's beneficiary_snapshot.account_number).
 */
export function openJsonField<T extends Record<string, any>>(row: T, column: keyof T & string, key: string): T {
  const j = row?.[column];
  return j && typeof j[key] === "string" ? { ...row, [column]: { ...j, [key]: openText(j[key]) } } : row;
}

// Every column that holds a secret this way: database, table, its key column, the secret column.
// With `json`, the column is jsonb and the secret is that key inside it.
//
// A sealed value differs every time it is written, so SQL cannot compare or search on these
// columns: read the row by something else and compare after openText.
export const SEALED_COLUMNS: { db: DbKey; table: string; key: string; column: string; json?: string }[] = [
  { db: "notification", table: "merchant_webhook_configs", key: "config_id", column: "secret" },
  // The v2 webhook signing secret (merchant 0014). Written sealed from the start.
  { db: "merchant", table: "merchants", key: "id", column: "webhook_secret" },
  { db: "vendorGateway", table: "vendor_email_inboxes", key: "email", column: "app_password" },
  { db: "vendorGateway", table: "vendor_email_inboxes", key: "email", column: "refresh_token" },
  { db: "fifo", table: "fifo_user_mfa", key: "email", column: "totp_secret" },
  // Bank account numbers. The last four digits are kept beside the payout beneficiary's
  // (account_last4) for display.
  { db: "fifo", table: "fifo_beneficiaries", key: "id", column: "account_number" },
  { db: "provider", table: "providers", key: "id", column: "bank_account_no" },
  { db: "provider", table: "provider_beneficiary_accounts", key: "id", column: "account_number" },
  { db: "provider", table: "provider_branch_settlements", key: "id", column: "beneficiary_snapshot", json: "account_number" },
  { db: "merchant", table: "merchant_bank_accounts", key: "id", column: "bank_account_no" },
];

/**
 * Seal every value in those columns that is still plaintext. Safe to run again: a sealed value
 * is skipped, and each row is only written if it still holds the plaintext that was read. A
 * table this database does not have is reported as `missing` and the rest still run.
 */
export async function sealPlaintextSecrets(): Promise<{ table: string; column: string; sealed: number; already: number; missing?: true }[]> {
  const out = [];
  for (const c of SEALED_COLUMNS) {
    const value = c.json ? `${c.column}->>'${c.json}'` : c.column;
    const name = c.json ? `${c.column}.${c.json}` : c.column;
    let all: { k: string; v: string }[];
    try {
      all = await rows<{ k: string; v: string }>(c.db,
        `SELECT ${c.key}::text AS k, ${value} AS v FROM ${c.table} WHERE ${value} IS NOT NULL AND ${value} <> ''`);
    } catch (err) {
      if (!["42P01", "42703"].includes((err as { code?: string }).code ?? "")) throw err;
      out.push({ table: c.table, column: name, sealed: 0, already: 0, missing: true as const });
      continue;
    }
    let sealed = 0;
    for (const r of all.filter((x) => !isSealed(x.v))) {
      const done = await rows(c.db, c.json
        ? `UPDATE ${c.table} SET ${c.column} = jsonb_set(${c.column}, '{${c.json}}', to_jsonb($1::text)) WHERE ${c.key}::text = $2 AND ${value} = $3 RETURNING 1`
        : `UPDATE ${c.table} SET ${c.column} = $1 WHERE ${c.key}::text = $2 AND ${c.column} = $3 RETURNING 1`,
        [sealText(r.v), r.k, r.v]);
      sealed += done.length;
    }
    out.push({ table: c.table, column: name, sealed, already: all.filter((x) => isSealed(x.v)).length });
  }
  return out;
}
