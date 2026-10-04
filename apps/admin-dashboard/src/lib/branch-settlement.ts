// Provider ↔ Branch settlement helpers: outstanding-balance computation, branch
// listing, and scope resolution. The settlement workflow itself (raise → UTR →
// verify → review) lives in the API routes; this is the shared data layer.

import { rows } from "@/lib/pg";
import { branchKeysForMerchant } from "@/lib/provider-integration";
import { bankerCoverage, coverageArgs, coverageCte, COVERED_SQL } from "@/lib/banker-settled";
import { payinChannelOf } from "@/lib/payin-channel";

export const SETTLEMENT_STATUSES = ["REQUESTED", "UTR_SUBMITTED", "VERIFIED", "REJECTED", "REVIEW", "CANCELLED"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

// Payout purpose codes by amount range. Used to
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
     WHERE vendor = 'KATANA' AND merchant_id = ANY($1::text[])
       AND status IN ('SUCCESS','SUCCEEDED')
       AND livemode = true   -- a test order never creates a settlement receivable
  `, [keys]).catch(() => [{ total: 0 }]);
  return r[0]?.total ?? 0;
}

// Sum of settlements the provider has confirmed receiving for a (provider, branch) pair.
// RECONCILED is the step after VERIFIED, so it counts too (as it does in lib/banker-settled).
export async function branchVerifiedSettled(providerId: string, merchantKey: string): Promise<number> {
  const r = await rows<{ total: number }>("provider", `
    SELECT COALESCE(SUM(amount),0)::float AS total
      FROM provider_branch_settlements
     WHERE provider_id = $1::uuid AND merchant_key = $2 AND status IN ('VERIFIED','RECONCILED')
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

// The same receivable per pay-in channel: what each channel collected, how much of it the
// banker's verified settlements cover (a settlement of that channel first, then one raised for
// both, oldest first — lib/banker-settled), and what is still outstanding. The channels add up
// to the banker's total.
export async function outstandingByChannel(providerId: string, merchantKey: string): Promise<
  Record<"INTENT" | "P2P" | "UNCLASSIFIED", { collected: number; settled: number; outstanding: number }>
> {
  const out = {
    INTENT: { collected: 0, settled: 0, outstanding: 0 },
    P2P: { collected: 0, settled: 0, outstanding: 0 },
    UNCLASSIFIED: { collected: 0, settled: 0, outstanding: 0 },
  };
  const keys = await branchKeysForMerchant(merchantKey);
  const cover = await bankerCoverage(providerId, keys);
  const r = await rows<{ channel_type: string; collected: number; settled: number }>("vendorGateway", `
    WITH ${coverageCte(1).trim()}
    SELECT c0.channel_type, SUM(c0.amount)::float AS collected,
           COALESCE(SUM(c0.amount) FILTER (WHERE ${COVERED_SQL}), 0)::float AS settled
      FROM cover0 c0 JOIN cover c ON c.id = c0.id
     GROUP BY 1
  `, coverageArgs(cover)).catch(() => []);
  for (const x of r) {
    const k = payinChannelOf(x.channel_type);
    out[k] = {
      collected: Math.round(x.collected * 100) / 100,
      settled: Math.round(x.settled * 100) / 100,
      outstanding: Math.max(0, Math.round((x.collected - x.settled) * 100) / 100),
    };
  }
  return out;
}
