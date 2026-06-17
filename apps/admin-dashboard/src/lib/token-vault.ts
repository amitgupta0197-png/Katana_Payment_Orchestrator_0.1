// Token vault (BRD §15 PCI scope control).
//
// "Store customer payment method tokens, provider tokens and token metadata;
// never expose sensitive card data."
//
// The application never sees raw PAN. Adapters return a provider-specific
// token (often opaque to us); we keep a sha256 hash of it so we can correlate
// without enabling its retrieval. The network token (Visa/MC tokenisation
// service reference) is stored separately because it is itself revocable.

import { createHash } from "crypto";
import { rows } from "@/lib/pg";

export type TokenStatus = "ACTIVE" | "SUSPENDED" | "EXPIRED" | "DELETED";

export interface CreateTokenInput {
  customerRef: string;
  merchantId: string;
  provider: string;
  providerTokenRaw: string;
  networkTokenId?: string;
  method: "CARD" | "UPI" | "WALLET";
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
}

export async function createToken(input: CreateTokenInput): Promise<{
  token_id: string; status: TokenStatus;
}> {
  const hash = createHash("sha256").update(input.providerTokenRaw).digest("hex");
  const r = await rows<{ token_id: string }>("checkout", `
    INSERT INTO payment_tokens
      (customer_ref, merchant_id, provider, provider_token_hash, network_token_id,
       method, brand, last4, exp_month, exp_year, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE')
    RETURNING token_id::text
  `, [
    input.customerRef, input.merchantId, input.provider.toUpperCase(),
    hash, input.networkTokenId ?? null,
    input.method.toUpperCase(), input.brand ?? null, input.last4 ?? null,
    input.expMonth ?? null, input.expYear ?? null,
  ]);
  return { token_id: r[0].token_id, status: "ACTIVE" };
}

export async function lookupToken(tokenId: string) {
  const r = await rows<any>("checkout", `
    SELECT token_id::text, customer_ref, merchant_id, provider, network_token_id,
           method, brand, last4, exp_month, exp_year, status,
           created_at, last_used_at
      FROM payment_tokens WHERE token_id = $1::uuid
  `, [tokenId]).catch(() => []);
  return r[0] ?? null;
}

export async function listTokens(filter: { merchantId?: string; customerRef?: string; status?: TokenStatus }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.merchantId)  { params.push(filter.merchantId);  where.push(`merchant_id = $${params.length}`); }
  if (filter.customerRef) { params.push(filter.customerRef); where.push(`customer_ref = $${params.length}`); }
  if (filter.status)      { params.push(filter.status);      where.push(`status = $${params.length}`); }
  return rows<any>("checkout", `
    SELECT token_id::text, customer_ref, merchant_id, provider,
           method, brand, last4, exp_month, exp_year, status,
           created_at, last_used_at,
           network_token_id IS NOT NULL AS has_network_token
      FROM payment_tokens
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY created_at DESC LIMIT 200
  `, params);
}

export async function setTokenStatus(tokenId: string, status: TokenStatus): Promise<void> {
  await rows("checkout",
    `UPDATE payment_tokens SET status=$1 WHERE token_id=$2::uuid`,
    [status, tokenId]).catch(() => null);
}

export async function markUsed(tokenId: string): Promise<void> {
  await rows("checkout",
    `UPDATE payment_tokens SET last_used_at=now() WHERE token_id=$1::uuid`,
    [tokenId]).catch(() => null);
}
