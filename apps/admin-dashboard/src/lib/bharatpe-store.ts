// BharatPe MIDs: the per-MID agent↔Katana credentials for a banker (vendorGateway 0046).
//
// A MID carries the BharatPe UPI ID the customer pays (also written as the banker's P2P settlement
// VPA by the setup route) and the API key + HMAC secret the Katana agent app signs its credit posts
// with. The secret is sealed and NEVER returned or logged; a freshly made or rotated secret is given
// back exactly once, by the function that made it, for the card to show that once.
//
// This holds no money and routes nothing: a BharatPe order is an ordinary pure-P2P order confirmed by
// the agent-reported credit (lib/bharatpe-setup, lib/txn-reconcile).

import { randomBytes } from "crypto";
import { rows } from "@/lib/pg";
import { sealText, openText } from "@/lib/sealed-text";
import { hint } from "@/lib/pg-catalog";
import { API_KEY_PREFIX, type BharatPeEnv } from "@/lib/bharatpe-setup";

export interface BharatPeMidRow {
  id: string;
  merchant_code: string;
  label: string;
  bharatpe_merchant_id: string | null;
  payee_vpa: string;
  env: BharatPeEnv;
  status: "ACTIVE" | "DISABLED";
  api_key_hint: string;
  created_at: string;
  updated_at: string;
}

/** A MID resolved for ingestion: the opened secret is included, so never return this to a client. */
export interface BharatPeMidAuth {
  id: string;
  merchant_code: string;
  label: string;
  payee_vpa: string;
  env: BharatPeEnv;
  status: "ACTIVE" | "DISABLED";
  secret: string;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function newApiKey(env: BharatPeEnv): string {
  return API_KEY_PREFIX[env] + b64url(randomBytes(18));
}
function newSecret(): string {
  return b64url(randomBytes(32));
}

/** Every BharatPe MID of a banker, newest first, with only a hint of each key and no secret. */
export async function listBharatPeMids(code: string): Promise<BharatPeMidRow[]> {
  const r = await rows<any>("vendorGateway", `
    SELECT id, merchant_code, label, bharatpe_merchant_id, payee_vpa, api_key, env, status, created_at, updated_at
      FROM bharatpe_mids WHERE merchant_code = $1 ORDER BY created_at DESC`, [code]);
  return r.map((x) => ({
    id: x.id, merchant_code: x.merchant_code, label: x.label,
    bharatpe_merchant_id: x.bharatpe_merchant_id ?? null, payee_vpa: x.payee_vpa,
    env: x.env, status: x.status, api_key_hint: hint(x.api_key),
    created_at: x.created_at, updated_at: x.updated_at,
  }));
}

/**
 * Create a BharatPe MID, or update an existing one by label. A new MID gets a fresh API key and
 * secret; an existing one keeps its key, and its secret is rotated only when rotateSecret is set.
 * Returns the row and, when a key or secret was minted, the plaintext to show ONCE (never stored).
 */
export async function saveBharatPeMid(input: {
  code: string;
  label: string;
  bharatpeMerchantId: string;
  payeeVpa: string;
  env: BharatPeEnv;
  rotateSecret?: boolean;
  by: string;
}): Promise<{ row: BharatPeMidRow; api_key?: string; secret?: string }> {
  const existing = await rows<{ id: string; env: BharatPeEnv }>("vendorGateway",
    `SELECT id, env FROM bharatpe_mids WHERE merchant_code = $1 AND label = $2`, [input.code, input.label]);

  if (!existing.length) {
    const apiKey = newApiKey(input.env);
    const secret = newSecret();
    const r = await rows<any>("vendorGateway", `
      INSERT INTO bharatpe_mids (merchant_code, label, bharatpe_merchant_id, payee_vpa, api_key, secret_sealed, env, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, merchant_code, label, bharatpe_merchant_id, payee_vpa, api_key, env, status, created_at, updated_at`,
      [input.code, input.label, input.bharatpeMerchantId || null, input.payeeVpa, apiKey, sealText(secret), input.env, input.by]);
    return { row: rowToView(r[0]), api_key: apiKey, secret };
  }

  // Rotating the key too when the env changes keeps the bpk_live_ / bpk_test_ prefix honest.
  const rotateKey = input.rotateSecret || existing[0].env !== input.env;
  const apiKey = rotateKey ? newApiKey(input.env) : null;
  const secret = input.rotateSecret ? newSecret() : null;
  const r = await rows<any>("vendorGateway", `
    UPDATE bharatpe_mids SET
      bharatpe_merchant_id = $3, payee_vpa = $4, env = $5,
      api_key = COALESCE($6, api_key),
      secret_sealed = COALESCE($7, secret_sealed),
      updated_at = now()
    WHERE id = $1 AND merchant_code = $2
    RETURNING id, merchant_code, label, bharatpe_merchant_id, payee_vpa, api_key, env, status, created_at, updated_at`,
    [existing[0].id, input.code, input.bharatpeMerchantId || null, input.payeeVpa, input.env, apiKey, secret ? sealText(secret) : null]);
  return { row: rowToView(r[0]), api_key: apiKey ?? undefined, secret: secret ?? undefined };
}

/** Pause or resume a MID: a disabled MID's posts are rejected at ingestion. */
export async function setBharatPeMidStatus(code: string, id: string, status: "ACTIVE" | "DISABLED"): Promise<boolean> {
  const r = await rows<{ id: string }>("vendorGateway",
    `UPDATE bharatpe_mids SET status = $3, updated_at = now() WHERE id = $1 AND merchant_code = $2 RETURNING id`,
    [id, code, status]);
  return r.length > 0;
}

/** The MID an API key belongs to, with its opened secret — for the ingestion endpoint only. */
export async function bharatpeMidByApiKey(apiKey: string): Promise<BharatPeMidAuth | null> {
  const r = await rows<any>("vendorGateway", `
    SELECT id, merchant_code, label, payee_vpa, secret_sealed, env, status
      FROM bharatpe_mids WHERE api_key = $1`, [apiKey]);
  if (!r.length) return null;
  const x = r[0];
  return {
    id: x.id, merchant_code: x.merchant_code, label: x.label, payee_vpa: x.payee_vpa,
    env: x.env, status: x.status, secret: openText(x.secret_sealed) ?? "",
  };
}

function rowToView(x: any): BharatPeMidRow {
  return {
    id: x.id, merchant_code: x.merchant_code, label: x.label,
    bharatpe_merchant_id: x.bharatpe_merchant_id ?? null, payee_vpa: x.payee_vpa,
    env: x.env, status: x.status, api_key_hint: hint(x.api_key),
    created_at: x.created_at, updated_at: x.updated_at,
  };
}
