// Katana-issued checkout integration credentials (Key + Salt) — ONE PAIR PER MODE.
//
// This is the MERCHANT-facing side of the orchestration. The merchant drops
// this Key + Salt into their checkout (e.g. PayU-style config.php) and signs
// each order request to Katana with it. Katana verifies the signature with the
// stored salt, then re-signs to the real gateway using the gateway creds
// (see lib/gateway-creds.ts).
//
//   key  — public-ish identifier the merchant sends with each request
//   salt — secret; shown to the merchant once at issue, stored sealed so Katana
//          can recompute and verify the inbound hash.
//
// TEST AND LIVE. A merchant holds a live pair (mk_live_…) and a test pair (mk_test_…), and
// the KEY a request is signed with decides whether the order is test or live — never a
// request field or a dashboard setting. Keys issued before test mode existed are plain
// mk_<hex>; they are live, so every integration already running keeps working unchanged.
//
// Storage, per mode:
//   vault           kind='merchant_secret', owner_type='merchant', owner_id=merchant_code,
//                   label='checkout_integration' (live, the original label) or
//                   'checkout_integration:test'
//   key lookup      merchant_checkout_keys (mkey, merchant_code, scheme, livemode),
//                   unique per (merchant_code, livemode) — checkout migrations 0007/0008.

import { randomBytes, timingSafeEqual } from "crypto";
import { storeCredential, readCredential } from "@/lib/credential-vault";
import { db, rows } from "@/lib/pg";
import { computeSignature, type SigningScheme, type GatewaySignInput } from "@/lib/gateway-creds";
import { assertLiveActivated } from "@/lib/live-activation";

const labelFor = (livemode: boolean) => (livemode ? "checkout_integration" : "checkout_integration:test");

export interface CheckoutCreds { key: string; salt: string; scheme: SigningScheme; }

/** The mode a presented key claims by its prefix. Legacy mk_<hex> keys are live. */
export function keyLivemode(mkey: string): boolean {
  return !mkey.startsWith("mk_test_");
}

// Generate (or rotate) the merchant's Key + Salt for ONE mode. Returns the salt in the clear
// ONCE so it can be shown to the merchant; subsequent reads only surface a hint.
//
// The sealed secret and the key lookup row are replaced in ONE transaction. They used to be
// separate writes with errors swallowed, so a failed insert could leave the vault holding a
// key that no lookup row pointed at — the merchant's integration then failed with "invalid
// key" and nothing reported why. Rotating one mode never touches the other mode's key.
export async function issueCheckoutCreds(merchantCode: string, scheme: SigningScheme, livemode = true): Promise<CheckoutCreds> {
  // A live pair needs live mode activated (lib/live-activation); a test pair never does.
  if (livemode) await assertLiveActivated(merchantCode);
  const creds: CheckoutCreds = {
    key: `${livemode ? "mk_live_" : "mk_test_"}${randomBytes(8).toString("hex")}`,
    salt: randomBytes(16).toString("hex"),
    scheme,
  };
  const client = await db("checkout").connect();
  try {
    await client.query("BEGIN");
    await storeCredential({
      kind: "merchant_secret", ownerType: "merchant", ownerId: merchantCode,
      label: labelFor(livemode), plaintext: JSON.stringify(creds),
    }, client);
    await client.query(
      `DELETE FROM merchant_checkout_keys WHERE merchant_code = $1 AND livemode = $2`,
      [merchantCode, livemode]);
    await client.query(
      `INSERT INTO merchant_checkout_keys (mkey, merchant_code, scheme, livemode) VALUES ($1, $2, $3, $4)`,
      [creds.key, merchantCode, creds.scheme, livemode]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return creds;
}

// Resolve a presented checkout key -> merchant and mode. Null for an unknown key, or for a key
// whose prefix disagrees with the mode it was issued in. Database errors propagate: a failure
// here must surface as a server error, not silently turn every live key into "invalid key".
export async function resolveCheckoutKey(mkey: string): Promise<{ merchantCode: string; livemode: boolean } | null> {
  const r = await rows<{ merchant_code: string; livemode: boolean }>("checkout",
    `SELECT merchant_code, livemode FROM merchant_checkout_keys WHERE mkey = $1`, [mkey]);
  const row = r[0];
  if (!row || row.livemode !== keyLivemode(mkey)) return null;
  return { merchantCode: row.merchant_code, livemode: row.livemode };
}

// Server-side full read — used to verify an inbound signed order and to sign callbacks.
export async function getCheckoutCreds(merchantCode: string, livemode = true): Promise<CheckoutCreds | null> {
  const pt = await readCredential({
    kind: "merchant_secret", ownerType: "merchant", ownerId: merchantCode, label: labelFor(livemode),
  });
  if (!pt) return null;
  try { return JSON.parse(pt) as CheckoutCreds; } catch { return null; }
}

// Non-secret status for the operator UI — key is shown (it's the public handle),
// salt is reduced to a hint.
export type CheckoutCredsStatus =
  | { configured: false }
  | { configured: true; key: string; scheme: SigningScheme; salt_hint: string };

export async function getCheckoutCredsStatus(merchantCode: string, livemode = true): Promise<CheckoutCredsStatus> {
  const c = await getCheckoutCreds(merchantCode, livemode);
  if (!c) return { configured: false };
  return { configured: true, key: c.key, scheme: c.scheme, salt_hint: `••••${c.salt.slice(-4)}` };
}

// Verify an inbound order signature the merchant computed with their Key + Salt.
export function verifyCheckoutSignature(creds: CheckoutCreds, order: GatewaySignInput, provided: string): boolean {
  const { signature } = computeSignature(creds, order);
  try {
    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(provided, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}
