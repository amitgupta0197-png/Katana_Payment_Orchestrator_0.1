// Provider-level PoolPay (Katana Pay) integration: storage, cascade resolution,
// and the SHA256 request signature defined in the PoolPay AUTO Integration Guide.
//
// THE MODEL
//   An admin configures a PG integration ONCE on a provider. Every merchant
//   (branch) mapped under that provider inherits it automatically. When a branch
//   creates a pay-in, resolvePoolPayConfig() walks:
//       merchant override (merchant_payment_config.poolpay)
//         > provider config (provider_integration_config)
//           > global env defaults (POOLPAY_* env)
//   so a single provider-level change "auto-integrates" all of its branches.
//
//   Secrets are kept out of provider_integration_config — they live encrypted in
//   the credential_vault and are only read server-side here.

import { createHash } from "crypto";
import { rows } from "@/lib/pg";
import { storeCredential, readCredential } from "@/lib/credential-vault";

export const POOLPAY_VENDOR = "POOLPAY";

const SECRET_LABEL = "poolpay:secret";
const APIKEY_LABEL = "poolpay:apikey";

export interface ProviderIntegration {
  provider_id: string;
  vendor: string;
  enabled: boolean;
  env: "SANDBOX" | "PROD";
  base_url: string | null;
  pay_id: string | null;
  client_id: string | null;
  return_url: string | null;
  callback_url: string | null;
  secret_set: boolean;
  apikey_set: boolean;
  config: Record<string, unknown>;
  updated_by: string | null;
  updated_at: string | null;
}

// ── Read / write provider config (no secrets returned) ─────────────────────────

export async function getProviderIntegration(
  providerId: string,
  vendor = POOLPAY_VENDOR,
): Promise<ProviderIntegration | null> {
  const r = await rows<ProviderIntegration>("provider", `
    SELECT provider_id::text, vendor, enabled, env,
           base_url, pay_id, client_id, return_url, callback_url,
           secret_set, apikey_set, config, updated_by, updated_at::text
      FROM provider_integration_config
     WHERE provider_id = $1::uuid AND vendor = $2
  `, [providerId, vendor]).catch(() => []);
  return r[0] ?? null;
}

export interface SetIntegrationFields {
  enabled?: boolean;
  env?: "SANDBOX" | "PROD";
  base_url?: string | null;
  pay_id?: string | null;
  client_id?: string | null;
  return_url?: string | null;
  callback_url?: string | null;
  config?: Record<string, unknown>;
  secret?: string;   // plaintext — vaulted, never persisted on the row
  api_key?: string;  // plaintext — vaulted, never persisted on the row
}

export async function setProviderIntegration(
  providerId: string,
  fields: SetIntegrationFields,
  actor: string,
  vendor = POOLPAY_VENDOR,
): Promise<ProviderIntegration> {
  // Vault the secrets first; only their presence flag lands on the row.
  let secretSet: boolean | null = null;
  let apikeySet: boolean | null = null;
  if (typeof fields.secret === "string" && fields.secret.length > 0) {
    await storeCredential({ kind: "vendor_secret", ownerType: "provider", ownerId: providerId, label: SECRET_LABEL, plaintext: fields.secret });
    secretSet = true;
  }
  if (typeof fields.api_key === "string" && fields.api_key.length > 0) {
    await storeCredential({ kind: "vendor_secret", ownerType: "provider", ownerId: providerId, label: APIKEY_LABEL, plaintext: fields.api_key });
    apikeySet = true;
  }

  const r = await rows<ProviderIntegration>("provider", `
    INSERT INTO provider_integration_config
      (provider_id, vendor, enabled, env, base_url, pay_id, client_id,
       return_url, callback_url, secret_set, apikey_set, config, updated_by, updated_at)
    VALUES ($1::uuid, $2,
            COALESCE($3, false), COALESCE($4,'SANDBOX'),
            $5, $6, $7, $8, $9,
            COALESCE($10, false), COALESCE($11, false),
            COALESCE($12,'{}')::jsonb, $13, now())
    ON CONFLICT (provider_id, vendor) DO UPDATE SET
      enabled      = COALESCE($3, provider_integration_config.enabled),
      env          = COALESCE($4, provider_integration_config.env),
      base_url     = COALESCE($5, provider_integration_config.base_url),
      pay_id       = COALESCE($6, provider_integration_config.pay_id),
      client_id    = COALESCE($7, provider_integration_config.client_id),
      return_url   = COALESCE($8, provider_integration_config.return_url),
      callback_url = COALESCE($9, provider_integration_config.callback_url),
      secret_set   = COALESCE($10, provider_integration_config.secret_set),
      apikey_set   = COALESCE($11, provider_integration_config.apikey_set),
      config       = COALESCE($12, provider_integration_config.config)::jsonb,
      updated_by   = $13,
      updated_at   = now()
    RETURNING provider_id::text, vendor, enabled, env, base_url, pay_id, client_id,
              return_url, callback_url, secret_set, apikey_set, config, updated_by, updated_at::text
  `, [
    providerId, vendor,
    fields.enabled ?? null,
    fields.env ?? null,
    fields.base_url ?? null,
    fields.pay_id ?? null,
    fields.client_id ?? null,
    fields.return_url ?? null,
    fields.callback_url ?? null,
    secretSet, apikeySet,
    fields.config ? JSON.stringify(fields.config) : null,
    actor,
  ]);
  return r[0];
}

// ── Cascade: which provider owns a merchant, and the effective config ──────────

// merchant_id on vendor_payin_orders / provider_merchant_mappings can be the
// merchant UUID (current) or the merchant_code (legacy). Resolve both keys so the
// cascade and funnel match either shape.
export async function branchKeysForMerchant(merchantKey: string): Promise<string[]> {
  const keys = new Set<string>([merchantKey]);
  const m = await rows<{ id: string; merchant_code: string }>("merchant", `
    SELECT id::text, merchant_code FROM merchants
     WHERE id::text = $1 OR merchant_code = $1 LIMIT 1
  `, [merchantKey]).catch(() => []);
  if (m[0]) { keys.add(m[0].id); keys.add(m[0].merchant_code); }
  return [...keys];
}

export async function providerForMerchant(merchantKey: string): Promise<string | null> {
  const keys = await branchKeysForMerchant(merchantKey);
  const r = await rows<{ provider_id: string }>("provider", `
    SELECT provider_id::text FROM provider_merchant_mappings
     WHERE merchant_id::text = ANY($1::text[]) AND status = 'ACTIVE'
     ORDER BY mapped_at DESC LIMIT 1
  `, [keys]).catch(() => []);
  return r[0]?.provider_id ?? null;
}

// Every merchant key (code + uuid) mapped under a provider — used to scope the
// reconciliation funnel to a provider's branches.
export async function branchKeysForProvider(providerId: string): Promise<string[]> {
  const map = await rows<{ merchant_id: string }>("provider", `
    SELECT merchant_id::text AS merchant_id FROM provider_merchant_mappings
     WHERE provider_id = $1::uuid AND status = 'ACTIVE'
  `, [providerId]).catch(() => []);
  if (!map.length) return [];
  const ids = map.map((m) => m.merchant_id);
  const merchants = await rows<{ id: string; merchant_code: string }>("merchant", `
    SELECT id::text, merchant_code FROM merchants
     WHERE id::text = ANY($1::text[]) OR merchant_code = ANY($1::text[])
  `, [ids]).catch(() => []);
  const keys = new Set<string>(ids);
  for (const m of merchants) { keys.add(m.id); keys.add(m.merchant_code); }
  return [...keys];
}

export interface EffectivePoolPayConfig {
  enabled: boolean;
  env: "SANDBOX" | "PROD";
  baseUrl: string | null;
  payId: string | null;
  returnUrl: string | null;
  clientId: string | null;
  secret: string | null;     // resolved plaintext (server-side only)
  apiKey: string | null;
  live: boolean;             // true when env=PROD + baseUrl + secret are all present
  providerId: string | null;
  source: "merchant" | "provider" | "env";
}

// Resolve the effective PoolPay config for a merchant/branch by cascading
// merchant override > provider config > env defaults. Reads vaulted secrets.
export async function resolvePoolPayConfig(merchantKey: string): Promise<EffectivePoolPayConfig> {
  // 1) env defaults
  let cfg: EffectivePoolPayConfig = {
    enabled: false,
    env: process.env.POOLPAY_MODE === "live" ? "PROD" : "SANDBOX",
    baseUrl: process.env.POOLPAY_BASE_URL ?? null,
    payId: process.env.POOLPAY_PAY_ID ?? null,
    returnUrl: process.env.POOLPAY_RETURN_URL ?? null,
    clientId: process.env.POOLPAY_CLIENT_ID ?? null,
    secret: process.env.POOLPAY_SECRET ?? null,
    apiKey: process.env.POOLPAY_API_KEY ?? null,
    live: false,
    providerId: null,
    source: "env",
  };

  // 2) provider config (cascade)
  const providerId = await providerForMerchant(merchantKey);
  if (providerId) {
    cfg.providerId = providerId;
    const p = await getProviderIntegration(providerId);
    if (p) {
      cfg.source = "provider";
      cfg.enabled = p.enabled;
      cfg.env = p.env;
      if (p.base_url) cfg.baseUrl = p.base_url;
      if (p.pay_id) cfg.payId = p.pay_id;
      if (p.return_url) cfg.returnUrl = p.return_url;
      if (p.client_id) cfg.clientId = p.client_id;
      if (p.secret_set) cfg.secret = (await readCredential({ kind: "vendor_secret", ownerType: "provider", ownerId: providerId, label: SECRET_LABEL })) ?? cfg.secret;
      if (p.apikey_set) cfg.apiKey = (await readCredential({ kind: "vendor_secret", ownerType: "provider", ownerId: providerId, label: APIKEY_LABEL })) ?? cfg.apiKey;
    }
  }

  // 3) merchant override (most specific)
  const mk = await rows<any>("merchant", `
    SELECT poolpay FROM merchant_payment_config WHERE merchant_code = $1
  `, [merchantKey]).catch(() => []);
  const ov = mk[0]?.poolpay;
  if (ov && typeof ov === "object") {
    if (typeof ov.enabled === "boolean") { cfg.enabled = ov.enabled; cfg.source = "merchant"; }
    if (ov.env === "PROD" || ov.env === "SANDBOX") cfg.env = ov.env;
    if (ov.pay_id) cfg.payId = ov.pay_id;
  }

  // Live only when explicitly PROD AND we have a base URL + secret to sign with.
  cfg.live = cfg.enabled && cfg.env === "PROD" && !!cfg.baseUrl && !!cfg.secret;
  return cfg;
}

// ── PoolPay SHA256 request signature (per the AUTO Integration Guide) ───────────
//
//   1. take the request name/value pairs (excluding HASH)
//   2. sort keys ascending, join as KEY=value with "~" as separator
//   3. append the SECRET_KEY directly to the end of the string (no separator)
//   4. SHA256 the string, hex-encode, UPPERCASE
//
// Empty values are kept as KEY= (the guide signs CUST_STREET_ADDRESS1= for blanks).
export function buildPoolPaySignString(params: Record<string, unknown>): string {
  // Code-unit (ASCII) sort — NOT localeCompare. The guide's param names are
  // uppercase ASCII and the gateway sorts by raw byte order; localeCompare could
  // reorder underscores vs letters and break the hash.
  const keys = Object.keys(params)
    .filter((k) => k.toUpperCase() !== "HASH")
    .sort();
  return keys.map((k) => {
    const v = params[k];
    return `${k}=${v === null || v === undefined ? "" : String(v)}`;
  }).join("~");
}

export function signPoolPay(params: Record<string, unknown>, secret: string): string {
  const base = buildPoolPaySignString(params) + secret;
  return createHash("sha256").update(base, "utf8").digest("hex").toUpperCase();
}

export function verifyPoolPayHash(
  params: Record<string, unknown>,
  secret: string,
  providedHash: string,
): boolean {
  const expected = signPoolPay(params, secret);
  const got = (providedHash ?? "").toUpperCase();
  // length-guarded constant-ish compare
  if (expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
