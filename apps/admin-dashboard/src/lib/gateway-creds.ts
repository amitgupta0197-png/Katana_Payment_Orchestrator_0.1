// Gateway MID credential mapping + request signing.
//
// Trust model (per product owner):
//   - The MERCHANT only ever holds their Katana API key/secret (sk_...).
//   - Katana stores the gateway-provided Main-MID *Key + Salt* (PayU / Airpay /
//     etc.) sealed in the credential vault, keyed by merchant_code. These NEVER
//     leave the server and are never returned to the merchant.
//   - At order time Katana maps merchant -> gateway MID creds internally and
//     signs the outbound gateway request itself.
//
// One sealed `mid_secret` vault row per merchant (label="gateway_mid") holds a
// JSON blob { gateway, mid_code, key, salt, scheme }.

import { createHash, createHmac } from "crypto";
import { storeCredential, readCredential } from "@/lib/credential-vault";
import { rows } from "@/lib/pg";

export type SigningScheme = "PAYU_SHA512" | "HMAC_SHA256";
export const SIGNING_SCHEMES: SigningScheme[] = ["PAYU_SHA512", "HMAC_SHA256"];

const VAULT_LABEL = "gateway_mid";

export interface GatewayMid {
  gateway: string;      // e.g. PAYU, AIRPAY
  mid_code: string;     // the Main MID identifier at the gateway
  key: string;          // gateway-provided merchant key
  salt: string;         // gateway-provided salt
  scheme: SigningScheme;
  env?: "TEST" | "PROD";   // gateway environment (PayU test vs secure). Default TEST.
}

// Persist (or rotate) a merchant's gateway MID credentials. Sealed at rest.
export async function storeGatewayMid(merchantCode: string, mid: GatewayMid): Promise<void> {
  await storeCredential({
    kind: "mid_secret", ownerType: "merchant", ownerId: merchantCode,
    label: VAULT_LABEL, plaintext: JSON.stringify(mid),
  });
}

// Internal resolver: merchant_code -> full gateway creds (key+salt included).
// Server-side only; never hand the result to a merchant response.
export async function getGatewayMid(merchantCode: string): Promise<GatewayMid | null> {
  const pt = await readCredential({
    kind: "mid_secret", ownerType: "merchant", ownerId: merchantCode, label: VAULT_LABEL,
  });
  if (!pt) return null;
  try { return JSON.parse(pt) as GatewayMid; } catch { return null; }
}

// Non-secret status for the operator UI — deliberately omits key + salt.
export type GatewayMidStatus =
  | { configured: false }
  | { configured: true; gateway: string; mid_code: string; scheme: SigningScheme; env: "TEST" | "PROD"; key_hint: string };

export async function getGatewayMidStatus(merchantCode: string): Promise<GatewayMidStatus> {
  const mid = await getGatewayMid(merchantCode);
  if (!mid) return { configured: false };
  return {
    configured: true, gateway: mid.gateway, mid_code: mid.mid_code, scheme: mid.scheme,
    env: mid.env ?? "TEST",
    key_hint: mid.key.length > 4 ? `••••${mid.key.slice(-4)}` : "••••",
  };
}

// Map a presented Katana API key secret (sk_...) -> owning merchant_code.
// Kept here so a future public Bearer-sk_ order endpoint can reuse the exact
// same mapping the dashboard flow relies on.
export async function resolveMerchantFromApiKey(secret: string): Promise<string | null> {
  const hash = createHash("sha256").update(secret).digest("hex");
  const r = await rows<{ owner_id: string }>("auth",
    `SELECT owner_id FROM api_keys
      WHERE owner_kind = 'MERCHANT' AND secret_hash = $1 AND status = 'ACTIVE' LIMIT 1`,
    [hash]).catch(() => []);
  return r[0]?.owner_id ?? null;
}

export interface GatewaySignInput {
  txnId: string;
  amount: string;          // major-unit amount as string (e.g. "100.00")
  productinfo?: string;
  firstname?: string;
  email?: string;
}

export interface KeySalt { key: string; salt: string; scheme: SigningScheme; }

// Compute a PayU-style request signature from any Key + Salt. Pluggable:
//   PAYU_SHA512 — PayU/Airpay/Easebuzz classic request hash:
//       sha512(key|txnid|amount|productinfo|firstname|email|udf1..udf5||||||salt)
//     (empty placeholders kept positional so the other side can re-derive it.)
//   HMAC_SHA256 — generic, mirrors lib/webhooks.ts signing: HMAC(key+salt, payload).
//
// Used on BOTH sides of the orchestration:
//   - Katana -> gateway  (gateway-provided key/salt)        via signForGateway()
//   - merchant -> Katana (Katana-issued key/salt)           via lib/merchant-checkout.ts
export function computeSignature(cred: KeySalt, order: GatewaySignInput): { scheme: SigningScheme; signature: string } {
  if (cred.scheme === "HMAC_SHA256") {
    const canonical = [order.txnId, order.amount, order.productinfo ?? "", order.email ?? ""].join("|");
    return { scheme: cred.scheme, signature: createHmac("sha256", `${cred.key}${cred.salt}`).update(canonical).digest("hex") };
  }
  // PAYU_SHA512 (default)
  const seq = [
    cred.key, order.txnId, order.amount,
    order.productinfo ?? "", order.firstname ?? "", order.email ?? "",
    "", "", "", "", "",     // udf1..udf5
    "", "", "", "", "",     // reserved blanks per PayU hash spec
    cred.salt,
  ].join("|");
  return { scheme: cred.scheme, signature: createHash("sha512").update(seq).digest("hex") };
}

// Sign Katana's outbound request to the gateway using the gateway-provided creds.
export function signForGateway(mid: GatewayMid, order: GatewaySignInput): { scheme: SigningScheme; signature: string } {
  return computeSignature({ key: mid.key, salt: mid.salt, scheme: mid.scheme }, order);
}
