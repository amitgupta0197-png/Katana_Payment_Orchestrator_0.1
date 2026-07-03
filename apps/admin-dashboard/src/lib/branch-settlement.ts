// Provider ↔ Branch settlement helpers: outstanding-balance computation, branch
// listing, and scope resolution. The settlement workflow itself (raise → UTR →
// verify → review) lives in the API routes; this is the shared data layer.

import { rows } from "@/lib/pg";
import { branchKeysForMerchant } from "@/lib/provider-integration";

export const SETTLEMENT_STATUSES = ["REQUESTED", "UTR_SUBMITTED", "VERIFIED", "REJECTED", "REVIEW", "CANCELLED"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

// PoolPay purpose codes by amount range (Withdrawal guide annexure). Used to
// default the settlement purpose; the provider can override.
export function purposeForAmount(amount: number): string {
  if (amount > 30000) return "VendorPayouts";
  if (amount > 10000) return "MarketingCampaign";
  if (amount <= 3000) return "Cashbacks";
  if (amount <= 5000) return "LoyaltyPointsRedemption";
  return "Refunds";
}

// Total successfully-collected pay-ins for a branch (the gross the branch took in
// via Katana Pay that it may owe upstream to the provider).
export async function branchCollectedSuccess(merchantKey: string): Promise<number> {
  const keys = await branchKeysForMerchant(merchantKey);
  const r = await rows<{ total: number }>("vendorGateway", `
    SELECT COALESCE(SUM(amount),0)::float AS total
      FROM vendor_payin_orders
     WHERE vendor = 'POOLPAY' AND merchant_id = ANY($1::text[])
       AND status IN ('SUCCESS','SUCCEEDED')
  `, [keys]).catch(() => [{ total: 0 }]);
  return r[0]?.total ?? 0;
}

// Sum of already-VERIFIED settlements for a (provider, branch) pair.
export async function branchVerifiedSettled(providerId: string, merchantKey: string): Promise<number> {
  const r = await rows<{ total: number }>("provider", `
    SELECT COALESCE(SUM(amount),0)::float AS total
      FROM provider_branch_settlements
     WHERE provider_id = $1::uuid AND merchant_key = $2 AND status = 'VERIFIED'
  `, [providerId, merchantKey]).catch(() => [{ total: 0 }]);
  return r[0]?.total ?? 0;
}

// Outstanding = collected SUCCESS pay-ins − already-verified settlements. This is
// the provider's receivable from the branch and the default settlement amount.
export async function outstandingForBranch(providerId: string, merchantKey: string): Promise<{
  collected: number; settled: number; outstanding: number;
}> {
  const [collected, settled] = await Promise.all([
    branchCollectedSuccess(merchantKey),
    branchVerifiedSettled(providerId, merchantKey),
  ]);
  return { collected, settled, outstanding: Math.max(0, Math.round((collected - settled) * 100) / 100) };
}

// Branches mapped under a provider, resolved to merchant_code + display name.
export async function branchesForProvider(providerId: string): Promise<
  { merchant_code: string; merchant_id: string; name: string }[]
> {
  const map = await rows<{ merchant_id: string }>("provider", `
    SELECT merchant_id::text AS merchant_id FROM provider_merchant_mappings
     WHERE provider_id = $1::uuid AND status = 'ACTIVE'
  `, [providerId]).catch(() => []);
  if (!map.length) return [];
  const ids = map.map((m) => m.merchant_id);
  const merchants = await rows<{ id: string; merchant_code: string; legal_name: string; brand_name: string }>(
    "merchant", `
      SELECT id::text, merchant_code, legal_name, COALESCE(brand_name,'') AS brand_name
        FROM merchants WHERE id::text = ANY($1::text[]) OR merchant_code = ANY($1::text[])
    `, [ids]).catch(() => []);
  // De-dup by merchant_code (a provider maps each branch once).
  const out = new Map<string, { merchant_code: string; merchant_id: string; name: string }>();
  for (const m of merchants) {
    out.set(m.merchant_code, { merchant_code: m.merchant_code, merchant_id: m.id, name: m.brand_name || m.legal_name || m.merchant_code });
  }
  return [...out.values()];
}
