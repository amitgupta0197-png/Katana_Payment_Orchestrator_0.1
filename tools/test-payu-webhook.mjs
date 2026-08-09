#!/usr/bin/env node
// Test the PayU webhook end-to-end without spending a rupee.
//
// A real PayU callback is just a signed form POST. This script creates a pending
// order, signs a payload exactly the way PayU would (reverse hash: salt|status|
// 10 blanks|email|firstname|productinfo|amount|txnid|key), posts it to the live
// webhook, and reports what the order did. That exercises every step the real
// thing does — merchant resolution from txnid, hash verification against the
// merchant's stored PayU salt, the already-final guard, and the state transition.
//
// RUN ON THE SERVER (needs the DB and VAULT_MASTER_KEY):
//   node tools/test-payu-webhook.mjs
//   node tools/test-payu-webhook.mjs --status failure
//   node tools/test-payu-webhook.mjs --bad-hash      # must NOT be credited
//   node tools/test-payu-webhook.mjs --replay        # second delivery must be a no-op
//   node tools/test-payu-webhook.mjs --keep          # leave the test order behind
//
// The merchant's salt is decrypted in-memory to sign the payload and is never
// printed. Test orders are deleted afterwards unless --keep.

import { createDecipheriv, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const APP_DIR  = process.env.KATANA_APP_DIR ?? "/opt/katana/apps/admin-dashboard";
const DB       = process.env.KATANA_CHECKOUT_DB ?? "checkoutservice_db";
const ENDPOINT = process.env.KATANA_WEBHOOK_URL ?? "http://127.0.0.1:3100/api/gateway/payu/webhook";

const arg  = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes(`--${name}`);

const MERCHANT = arg("merchant", "K-001");
const AMOUNT   = arg("amount", "1.00");
const STATUS   = arg("status", "success");
const EMAIL    = "webhook-test@katanapay.co";
const NAME     = "Webhook Test";
const PRODUCT  = "Webhook test";

const psql = (sql) =>
  execFileSync("sudo", ["-u", "postgres", "psql", "-d", DB, "-t", "-A", "-F", "\t", "-c", sql], { encoding: "utf8" }).trim();

function envVar(key) {
  const line = readFileSync(`${APP_DIR}/.env.local`, "utf8")
    .split("\n").find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} not found in ${APP_DIR}/.env.local`);
  return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
}

// Mirror of lib/credential-vault.ts — AES-256-GCM under VAULT_MASTER_KEY.
function loadGatewayMid(merchant) {
  const row = psql(
    `SELECT encode(iv,'hex'), encode(auth_tag,'hex'), encode(ciphertext,'hex')
       FROM credential_vault
      WHERE kind='mid_secret' AND owner_type='merchant'
        AND owner_id='${merchant}' AND label='gateway_mid'
      ORDER BY key_version DESC LIMIT 1`);
  if (!row) throw new Error(`no gateway MID stored for merchant ${merchant}`);
  const [iv, tag, ct] = row.split("\t");
  const key = Buffer.from(envVar("VAULT_MASTER_KEY"), "base64");
  if (key.length !== 32) throw new Error("VAULT_MASTER_KEY must decode to 32 bytes");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "hex")), d.final()]).toString("utf8"));
}

// Mirror of lib/payu.ts payuResponseHash().
const responseHash = (mid, p) => createHash("sha512").update([
  mid.salt, p.status, ...Array(10).fill(""),
  p.email, p.firstname, p.productinfo, p.amount, p.txnid, mid.key,
].join("|")).digest("hex");

const step = (n, msg) => console.log(`\n\x1b[36m${n}\x1b[0m ${msg}`);
const ok   = (msg) => console.log(`   \x1b[32m✓\x1b[0m ${msg}`);
const bad  = (msg) => console.log(`   \x1b[31m✗\x1b[0m ${msg}`);

const mid = loadGatewayMid(MERCHANT);
step("1/5", `Merchant ${MERCHANT} → gateway ${mid.gateway}, MID ${mid.mid_code}, env ${mid.env ?? "TEST"}`);
if (mid.gateway !== "PAYU") { bad(`gateway is ${mid.gateway}, not PAYU — nothing to test`); process.exit(1); }
ok("PayU key + salt decrypted (not printed)");

const txnid = `WHTEST-${Date.now()}`;
step("2/5", `Creating pending order ${txnid} for ₹${AMOUNT}`);
psql(`INSERT INTO checkout_orders
        (tenant_id, merchant_id, client_ref, txn_id, amount, amount_minor, currency,
         method, status, idempotency_key, customer_email)
      VALUES ('tenant-default','${MERCHANT}','${PRODUCT}','${txnid}',${AMOUNT},
              ${Math.round(Number(AMOUNT) * 100)},'INR','UPI','PENDING','${txnid}','${EMAIL}')`);
ok("order is PENDING");

const payload = {
  mihpayid: `TEST${Date.now()}`, mode: "UPI", status: STATUS, txnid,
  amount: AMOUNT, productinfo: PRODUCT, firstname: NAME, email: EMAIL,
  phone: "9999999999", bank_ref_num: `${Date.now()}`.slice(-12), key: mid.key,
};
payload.hash = flag("bad-hash")
  ? "0".repeat(128)
  : responseHash(mid, { status: STATUS, email: EMAIL, firstname: NAME, productinfo: PRODUCT, amount: AMOUNT, txnid });

step("3/5", `POSTing a ${flag("bad-hash") ? "DELIBERATELY UNSIGNED" : "signed"} "${STATUS}" callback to ${ENDPOINT}`);
const post = async () => {
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(payload).toString(),
  });
  return { code: r.status, body: await r.json().catch(() => ({})) };
};

const res = await post();
console.log(`   HTTP ${res.code}  ${JSON.stringify(res.body)}`);
res.code === 200 ? ok("2xx — PayU will not retry") : bad(`${res.code} — PayU would treat this as failed delivery and retry`);
res.body.hash_verified ? ok("hash verified against the stored salt")
                       : bad("hash NOT verified" + (flag("bad-hash") ? " (expected — this is the negative test)" : " — check the stored PayU key/salt"));

if (flag("replay")) {
  step("3b", "Replaying the identical callback (duplicate delivery)");
  const again = await post();
  console.log(`   HTTP ${again.code}  ${JSON.stringify(again.body)}`);
  again.body.applied === false ? ok("applied=false — idempotent, not double-counted")
                               : bad("applied=true on replay — the already-final guard did not hold");
}

step("4/5", "Reading the order back");
const [status, transition] = [
  psql(`SELECT status FROM checkout_orders WHERE txn_id='${txnid}'`),
  psql(`SELECT to_status, reason FROM order_state_transitions t
          JOIN checkout_orders o ON o.id = t.order_id
         WHERE o.txn_id='${txnid}' ORDER BY t.ctid DESC LIMIT 1`),
];
console.log(`   status: ${status}    transition: ${transition || "(none)"}`);

const expected = flag("bad-hash") ? "FAILED" : STATUS === "success" ? "SUCCESS" : "FAILED";
status === expected ? ok(`order is ${status} — as expected`)
                    : bad(`order is ${status}, expected ${expected}`);

step("5/5", flag("keep") ? "Leaving the test order in place (--keep)" : "Cleaning up");
if (!flag("keep")) {
  psql(`DELETE FROM order_state_transitions WHERE order_id IN (SELECT id FROM checkout_orders WHERE txn_id='${txnid}')`);
  psql(`DELETE FROM checkout_orders WHERE txn_id='${txnid}'`);
  ok("test order removed");
} else {
  ok(`kept as ${txnid}`);
}
