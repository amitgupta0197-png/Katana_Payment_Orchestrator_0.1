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
import { gatewayDef, hint, type AuthModeId } from "@/lib/pg-catalog";

export type SigningScheme = "PAYU_SHA512" | "HMAC_SHA256";
export const SIGNING_SCHEMES: SigningScheme[] = ["PAYU_SHA512", "HMAC_SHA256"];

const VAULT_LABEL = "gateway_mid";

export interface GatewayMid {
  gateway: string;      // lib/pg-catalog GatewayId: PAYU, RAZORPAY, CASHFREE, CCAVENUE, PHONEPE, PAYTM, RUBYVAULT, ISMARTPAY
  mid_code: string;     // the merchant's id at the gateway
  key: string;          // the gateway's public credential (PayU key, Razorpay Key ID, Cashfree App ID, …)
  salt: string;         // the gateway's secret (PayU salt, Razorpay Key Secret, CCAvenue Working Key, …)
  scheme: SigningScheme;
  env?: "TEST" | "PROD";   // gateway environment. Default TEST.
  /**
   * How Katana signs in to the gateway (lib/pg-catalog altAuth). Absent = the gateway's default.
   * PayU "client_credentials": key = Client ID, salt = Client Secret, Payment Links API only.
   */
  auth?: AuthModeId;
  /** Gateway-specific extras (Razorpay webhook secret, PhonePe client version, Paytm website, …). */
  extra?: Record<string, string>;
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

/**
 * The merchant's PayU Key + Salt, or null. Everything in lib/payu-* signs with the Salt, so it
 * must never be handed a PayU Client ID + Secret (Payment Links mode, lib/payin-providers/payu-links).
 */
export function payuKeySalt(mid: GatewayMid | null | undefined): GatewayMid | null {
  return mid && mid.gateway === "PAYU" && (mid.auth ?? "key_salt") === "key_salt" ? mid : null;
}

/** The id live pay-ins are switched on under (PAYIN_CONNECTORS_PROD): PAYU_LINKS for PayU Client ID mode. */
export function payinProdId(mid: Pick<GatewayMid, "gateway" | "auth">): string {
  return mid.gateway === "PAYU" && mid.auth === "client_credentials" ? "PAYU_LINKS" : mid.gateway;
}

// Non-secret status for the operator UI — deliberately omits key + salt.
export type GatewayMidStatus =
  | { configured: false }
  | {
      configured: true; gateway: string; gateway_name: string; connector: boolean;
      mid_code: string; scheme: SigningScheme; env: "TEST" | "PROD"; env_label: string; key_hint: string;
      auth: AuthModeId; auth_label: string | null;
    };

export async function getGatewayMidStatus(merchantCode: string): Promise<GatewayMidStatus> {
  const mid = await getGatewayMid(merchantCode);
  if (!mid) return { configured: false };
  const def = gatewayDef(mid.gateway);
  const env = mid.env ?? "TEST";
  const alt = mid.auth ? def?.payin.altAuth?.find((m) => m.id === mid.auth) : undefined;
  return {
    configured: true, gateway: mid.gateway, gateway_name: def?.name ?? mid.gateway,
    connector: def?.payin.connector ?? false,
    mid_code: mid.mid_code, scheme: mid.scheme, env, env_label: (alt?.env ?? def?.payin.env)?.[env] ?? env,
    key_hint: hint(mid.key),
    auth: mid.auth ?? "key_salt",
    auth_label: alt?.label ?? def?.payin.defaultAuthLabel ?? null,
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
