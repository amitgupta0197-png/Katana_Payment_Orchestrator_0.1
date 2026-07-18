#!/usr/bin/env node
// Vault re-seal migration (security audit C4 / VPS-compromise rotation).
//
// The credential vault (checkoutservice_db.credential_vault) was sealed under the
// dev-default master key (32 bytes of 0x42) because VAULT_MASTER_KEY was never set in
// production. That key is public (it's in the source), so every sealed secret — PoolPay
// SECRET_KEY, gateway MID key+salt, merchant checkout salts, bank creds — is effectively
// decryptable by anyone. This script rotates the vault to a real key by decrypting each
// row with the OLD key and re-encrypting (fresh IV) with the NEW key, in place.
//
// A bare key swap would leave every existing ciphertext undecryptable, so this migration
// is REQUIRED before the app runs with a real VAULT_MASTER_KEY.
//
// Usage:
//   node tools/reseal-vault.mjs --gen-key                 # print a fresh base64 32-byte key
//   node tools/reseal-vault.mjs --dry-run                 # report what would change, no writes
//   node tools/reseal-vault.mjs                           # perform the re-seal
//
// Env:
//   PG_HOST / PG_PORT / PG_USER / PG_PASSWORD             # same as the app (checkoutservice_db)
//   VAULT_MASTER_KEY_NEW   (base64, 32 bytes)  REQUIRED   # the new master key to seal under
//   VAULT_MASTER_KEY_OLD   (base64, 32 bytes)  optional   # defaults to the dev 0x42 key
//
// After a successful run: set VAULT_MASTER_KEY = <the same value as VAULT_MASTER_KEY_NEW>
// in the app's .env.local, then restart. Verify a known credential decrypts (e.g. load a
// provider integration page). Keep the OLD key around until you've verified, then destroy it.

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import pg from "pg";

function genKey() {
  return randomBytes(32).toString("base64");
}

function loadKey(envName, fallback) {
  const v = process.env[envName];
  if (!v) return fallback ?? null;
  const k = Buffer.from(v, "base64");
  if (k.length !== 32) { console.error(`${envName} must decode to 32 bytes (got ${k.length})`); process.exit(1); }
  return k;
}

function decrypt(key, iv, authTag, ciphertext) {
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(authTag);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

function encrypt(key, plaintext) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, authTag: c.getAuthTag(), ciphertext };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--gen-key")) { console.log(genKey()); return; }
  const dryRun = args.includes("--dry-run");

  const OLD = loadKey("VAULT_MASTER_KEY_OLD", Buffer.alloc(32, 0x42)); // dev default was in use
  const NEW = loadKey("VAULT_MASTER_KEY_NEW", null);
  if (!NEW) { console.error("VAULT_MASTER_KEY_NEW is required (base64 32 bytes). Generate one with --gen-key."); process.exit(1); }
  if (OLD.equals(NEW)) { console.error("OLD and NEW keys are identical — nothing to rotate."); process.exit(1); }

  const client = new pg.Client({
    host: process.env.PG_HOST ?? "localhost",
    port: Number(process.env.PG_PORT ?? 5432),
    user: process.env.PG_USER ?? "sixsenai",
    password: process.env.PG_PASSWORD ?? "",
    database: "checkoutservice_db",
  });
  await client.connect();

  const { rows } = await client.query(
    `SELECT credential_id::text AS id, kind, owner_type, label, iv, auth_tag, ciphertext FROM credential_vault`
  );
  console.log(`${rows.length} vault row(s) found.${dryRun ? " (dry-run — no writes)" : ""}`);

  let resealed = 0, alreadyNew = 0, failed = 0;
  for (const r of rows) {
    let plaintext;
    try {
      plaintext = decrypt(OLD, r.iv, r.auth_tag, r.ciphertext);   // expected path: sealed under OLD
    } catch {
      try { decrypt(NEW, r.iv, r.auth_tag, r.ciphertext); alreadyNew++; continue; } // already migrated
      catch { failed++; console.error(`  ✗ ${r.id} (${r.kind}/${r.owner_type}/${r.label}) — decrypts under neither key; left untouched`); continue; }
    }
    if (dryRun) { resealed++; continue; }
    const sealed = encrypt(NEW, plaintext);
    await client.query(
      `UPDATE credential_vault SET iv=$2, auth_tag=$3, ciphertext=$4, rotated_at=now() WHERE credential_id=$1::uuid`,
      [r.id, sealed.iv, sealed.authTag, sealed.ciphertext]
    );
    resealed++;
  }

  await client.end();
  console.log(`\nDone. re-sealed: ${resealed}${dryRun ? " (would)" : ""} · already-new: ${alreadyNew} · failed: ${failed}`);
  if (failed > 0) { console.error("Some rows could not be decrypted with either key — investigate before rotating VAULT_MASTER_KEY."); process.exit(2); }
  if (!dryRun) console.log("Next: set VAULT_MASTER_KEY = VAULT_MASTER_KEY_NEW in .env.local and restart the app.");
}

main().catch((e) => { console.error(e); process.exit(1); });
