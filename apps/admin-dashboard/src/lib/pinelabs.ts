// Pine Labs (Plural) per-merchant credential store + config helper. Non-secret config is
// kept in merchantservice_db.pinelabs_config; the client_secret is sealed in the shared
// credential vault. Used by the admin + merchant "Add Pine Labs keys" surfaces, and later
// by the connector that pulls transactions/RRN from Pine Labs (api.pluralpay.in).

import { rows } from "@/lib/pg";
import { storeCredential, readCredential } from "@/lib/credential-vault";

const SECRET_LABEL = "pinelabs_client_secret";

export const PINELABS_BASE: Record<"SANDBOX" | "PROD", string> = {
  PROD: "https://api.pluralpay.in",
  SANDBOX: "https://pluraluat.v2.pinepg.in",
};

export interface PinelabsConfig {
  enabled: boolean;
  env: "SANDBOX" | "PROD";
  client_id: string;
  pinelabs_merchant_id: string;
  secret_set: boolean;
  updated_by: string;
  updated_at: string | null;
}

const EMPTY: PinelabsConfig = {
  enabled: false, env: "PROD", client_id: "", pinelabs_merchant_id: "",
  secret_set: false, updated_by: "", updated_at: null,
};

// Canonical merchant_code for a session scope / branch id (accepts code or uuid).
export async function resolveMerchantCode(idOrCode: string): Promise<string> {
  const r = await rows<{ merchant_code: string }>("merchant",
    `SELECT merchant_code FROM merchants WHERE merchant_code = $1 OR id::text = $1 LIMIT 1`,
    [idOrCode]).catch(() => []);
  return r[0]?.merchant_code ?? idOrCode;
}

export async function getPinelabsConfig(merchantCode: string): Promise<PinelabsConfig> {
  const r = await rows<PinelabsConfig>("merchant", `
    SELECT enabled, env, COALESCE(client_id,'') AS client_id,
           COALESCE(pinelabs_merchant_id,'') AS pinelabs_merchant_id,
           secret_set, COALESCE(updated_by,'') AS updated_by, updated_at
      FROM pinelabs_config WHERE merchant_code = $1
  `, [merchantCode]).catch(() => []);
  return r[0] ?? EMPTY;
}

export interface SaveInput {
  enabled?: boolean;
  env?: "SANDBOX" | "PROD";
  client_id?: string;
  pinelabs_merchant_id?: string;
  client_secret?: string;   // write-only; only sealed when a non-empty value is supplied
}

export async function savePinelabsConfig(merchantCode: string, input: SaveInput, actor: string): Promise<void> {
  let secretSet: boolean | null = null;
  const secret = input.client_secret?.trim();
  if (secret) {
    await storeCredential({
      kind: "merchant_secret", ownerType: "merchant", ownerId: merchantCode,
      label: SECRET_LABEL, plaintext: secret,
    });
    secretSet = true;
  }
  await rows("merchant", `
    INSERT INTO pinelabs_config
      (merchant_code, enabled, env, client_id, pinelabs_merchant_id, secret_set, updated_by, updated_at)
    VALUES ($1, COALESCE($2,false), COALESCE($3,'PROD'), $4, $5, COALESCE($6,false), $7, now())
    ON CONFLICT (merchant_code) DO UPDATE SET
      enabled              = COALESCE($2, pinelabs_config.enabled),
      env                  = COALESCE($3, pinelabs_config.env),
      client_id            = COALESCE($4, pinelabs_config.client_id),
      pinelabs_merchant_id = COALESCE($5, pinelabs_config.pinelabs_merchant_id),
      secret_set           = CASE WHEN $6::boolean IS TRUE THEN true ELSE pinelabs_config.secret_set END,
      updated_by           = $7, updated_at = now()
  `, [merchantCode, input.enabled ?? null, input.env ?? null,
      input.client_id ?? null, input.pinelabs_merchant_id ?? null, secretSet, actor]);
}

// For the connector (phase 2): the sealed client_secret, decrypted.
export async function readPinelabsSecret(merchantCode: string): Promise<string | null> {
  return readCredential({
    kind: "merchant_secret", ownerType: "merchant", ownerId: merchantCode, label: SECRET_LABEL,
  });
}
