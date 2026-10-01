// Which merchant (provider) a banker belongs to, and every key a banker or a merchant's
// bankers can appear under in the pay-in tables.

import { rows } from "@/lib/pg";

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
