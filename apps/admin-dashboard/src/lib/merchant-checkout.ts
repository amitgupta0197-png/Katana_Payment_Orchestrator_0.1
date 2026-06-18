// Katana-issued checkout integration credentials (Key + Salt).
//
// This is the MERCHANT-facing side of the orchestration. The merchant drops
// this Key + Salt into their checkout (e.g. PayU-style config.php) and signs
// each order request to Katana with it. Katana verifies the signature with the
// stored salt, then re-signs to the real gateway using the gateway creds
// (see lib/gateway-creds.ts).
//
//   key  — public-ish identifier the merchant sends with each request (mk_...)
//   salt — secret; shown to the merchant once at issue, stored sealed so Katana
//          can recompute and verify the inbound hash.
//
// Stored as one sealed vault row per merchant: kind='merchant_secret',
// owner_type='merchant', owner_id=merchant_code, label='checkout_integration'.

import { randomBytes, timingSafeEqual } from "crypto";
import { storeCredential, readCredential } from "@/lib/credential-vault";
import { rows } from "@/lib/pg";
import { computeSignature, type SigningScheme, type GatewaySignInput } from "@/lib/gateway-creds";

const LABEL = "checkout_integration";

export interface CheckoutCreds { key: string; salt: string; scheme: SigningScheme; }

// Generate (or rotate) the merchant's checkout Key + Salt. Returns the salt in
// the clear ONCE so it can be shown to the merchant; subsequent reads only ever
// surface a hint (see getCheckoutCredsStatus).
export async function issueCheckoutCreds(merchantCode: string, scheme: SigningScheme): Promise<CheckoutCreds> {
  const creds: CheckoutCreds = {
    key: `mk_${randomBytes(8).toString("hex")}`,
    salt: randomBytes(16).toString("hex"),
    scheme,
  };
  await storeCredential({
    kind: "merchant_secret", ownerType: "merchant", ownerId: merchantCode,
    label: LABEL, plaintext: JSON.stringify(creds),
  });
  // Maintain the key -> merchant lookup (one active key per merchant; the new
  // key supersedes any previous one).
  await rows("checkout", `DELETE FROM merchant_checkout_keys WHERE merchant_code = $1`, [merchantCode]).catch(() => {});
  await rows("checkout", `
    INSERT INTO merchant_checkout_keys (mkey, merchant_code, scheme)
    VALUES ($1, $2, $3)
  `, [creds.key, merchantCode, creds.scheme]).catch(() => {});
  return creds;
}

// Resolve a presented checkout key (mk_...) -> merchant_code. Returns null for
// an unknown key.
export async function resolveMerchantByCheckoutKey(mkey: string): Promise<string | null> {
  const r = await rows<{ merchant_code: string }>("checkout",
    `SELECT merchant_code FROM merchant_checkout_keys WHERE mkey = $1`, [mkey]).catch(() => []);
  return r[0]?.merchant_code ?? null;
}

// Server-side full read — used to verify an inbound signed order.
export async function getCheckoutCreds(merchantCode: string): Promise<CheckoutCreds | null> {
  const pt = await readCredential({
    kind: "merchant_secret", ownerType: "merchant", ownerId: merchantCode, label: LABEL,
  });
  if (!pt) return null;
  try { return JSON.parse(pt) as CheckoutCreds; } catch { return null; }
}

// Non-secret status for the operator UI — key is shown (it's the public handle),
// salt is reduced to a hint.
export type CheckoutCredsStatus =
  | { configured: false }
  | { configured: true; key: string; scheme: SigningScheme; salt_hint: string };

export async function getCheckoutCredsStatus(merchantCode: string): Promise<CheckoutCredsStatus> {
  const c = await getCheckoutCreds(merchantCode);
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
