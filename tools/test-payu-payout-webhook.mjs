#!/usr/bin/env node
// Test the PayU payout webhook on the server without moving a rupee.
//
// PayU payout webhooks are not signed, so Katana checks two things: the Authorization
// token registered with PayU, and PayU's own status API, which decides the outcome. This
// script proves both hold:
//
//   default   creates a SUBMITTED payout PayU has never heard of, then sends
//               1. an event with no token          -> must be 401 (once a webhook is registered)
//               2. a forged TRANSFER_SUCCESS with the right token -> must stay SUBMITTED,
//                  because PayU's status API has no such transfer
//   --ref TXN-...   sends a TRANSFER_SUCCESS hint for a REAL payout (e.g. one made on PayU UAT)
//                   and shows what PayU's status API made of it
//
// RUN ON THE SERVER (needs the DB and VAULT_MASTER_KEY):
//   node tools/test-payu-payout-webhook.mjs --merchant K-001
//   node tools/test-payu-payout-webhook.mjs --merchant K-001 --ref TXN-0123ABCD
//
// The webhook token is decrypted in memory and never printed. The fake payout is deleted
// afterwards unless --keep.

import { createDecipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const APP_DIR  = process.env.KATANA_APP_DIR ?? "/opt/katana/apps/admin-dashboard";
const ENDPOINT = process.env.KATANA_PAYOUT_WEBHOOK_URL ?? "http://127.0.0.1:3100/api/gateway/payu/payout-webhook";

const arg  = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes(`--${name}`);
const MERCHANT = arg("merchant", "K-001");
const REF = arg("ref");

const psql = (db, sql) =>
  execFileSync("sudo", ["-u", "postgres", "psql", "-d", db, "-t", "-A", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

function envVar(key) {
  const line = readFileSync(`${APP_DIR}/.env.local`, "utf8").split("\n").find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} not found in ${APP_DIR}/.env.local`);
  return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
}

// Mirror of lib/credential-vault.ts — AES-256-GCM under VAULT_MASTER_KEY.
function loadPayoutCreds(merchant) {
  const row = psql("checkoutservice_db",
    `SELECT encode(iv,'hex'), encode(auth_tag,'hex'), encode(ciphertext,'hex')
       FROM credential_vault
      WHERE kind='mid_secret' AND owner_type='merchant' AND owner_id=${lit(merchant)} AND label='payu_payout'
      ORDER BY key_version DESC LIMIT 1`);
  if (!row) throw new Error(`no PayU payout credentials stored for merchant ${merchant}`);
  const [iv, tag, ct] = row.split("\t");
  const key = Buffer.from(envVar("VAULT_MASTER_KEY"), "base64");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "hex")), d.final()]).toString("utf8"));
}

const step = (n, msg) => console.log(`\n\x1b[36m${n}\x1b[0m ${msg}`);
const ok   = (msg) => console.log(`   \x1b[32m✓\x1b[0m ${msg}`);
const bad  = (msg) => { console.log(`   \x1b[31m✗\x1b[0m ${msg}`); process.exitCode = 1; };

async function send(event, ref, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = token;
  const r = await fetch(ENDPOINT, {
    method: "POST", headers,
    body: JSON.stringify({ event, payuRefId: `TEST${Date.now()}`, merchantReferenceId: ref, bankReferenceId: "000000000000" }),
  });
  const body = await r.json().catch(() => ({}));
  console.log(`   HTTP ${r.status}  ${JSON.stringify(body)}`);
  return { code: r.status, body };
}
const statusOf = (ref) => psql("fifoservice_db", `SELECT status FROM fifo_orders WHERE txn_ref=${lit(ref)}`);

const creds = loadPayoutCreds(MERCHANT);
step("1", `Merchant ${MERCHANT} → PayU payout account ${creds.payout_merchant_id}, env ${creds.env}`);
creds.webhook_token ? ok("webhook token decrypted (not printed)")
                    : console.log("   ! webhook not registered from Katana yet — only the status-API check applies");

if (REF) {
  step("2", `Sending a TRANSFER_SUCCESS hint for ${REF} (status before: ${statusOf(REF) || "not found"})`);
  await send("TRANSFER_SUCCESS", REF, creds.webhook_token);
  console.log(`   status after: ${statusOf(REF)}`);
  process.exit();
}

const ref = `TXN-WHTEST${randomBytes(4).toString("hex").toUpperCase()}`;
step("2", `Creating a SUBMITTED PayU payout ${ref} that PayU has never seen`);
psql("fifoservice_db", `INSERT INTO fifo_orders
    (order_ref, merchant_id, direction, amount_minor, currency, settlement_mode, purpose, txn_ref, status,
     provider, payout_rail, livemode, submitted_at)
  VALUES (${lit("PO-" + ref)}, ${lit(MERCHANT)}, 'PAYOUT', 100, 'INR', 'BANK', 'webhook test', ${lit(ref)}, 'SUBMITTED',
          'PAYU', 'IMPS', false, now())`);
ok("payout is SUBMITTED");

try {
  if (creds.webhook_token) {
    step("3", "Event with NO token");
    const r = await send("TRANSFER_SUCCESS", ref, null);
    r.code === 401 ? ok("401 — rejected") : bad(`expected 401, got ${r.code}`);
  } else {
    step("3", "Skipped the no-token check (no token registered)");
  }

  step("4", "Forged TRANSFER_SUCCESS with the right token");
  const r = await send("TRANSFER_SUCCESS", ref, creds.webhook_token);
  r.code === 200 ? ok("200 — PayU would not retry") : bad(`expected 200, got ${r.code}`);
  const after = statusOf(ref);
  after === "SUBMITTED" ? ok(`still SUBMITTED (PayU status API: ${r.body.outcome}) — a webhook alone can't mark a payout paid`)
                        : bad(`payout moved to ${after} on an unconfirmed webhook`);
} finally {
  step("5", flag("keep") ? `Leaving ${ref} in place (--keep)` : "Cleaning up");
  if (!flag("keep")) {
    psql("fifoservice_db", `DELETE FROM fifo_order_events WHERE order_id IN (SELECT id FROM fifo_orders WHERE txn_ref=${lit(ref)})`);
    psql("fifoservice_db", `DELETE FROM fifo_orders WHERE txn_ref=${lit(ref)}`);
    ok("test payout removed");
  }
}
