// USDT settlement controls (PayTech BRD §11.C, §22, FR-008): network whitelist,
// rate capture + lock, and amount computation. Wallet whitelisting is enforced via
// the beneficiary registry (APPROVED status). tx_hash is required to complete a
// USDT transfer (enforced in the order action route).

import { getQuote } from "@/lib/fx";

// Allowed settlement networks (BRD §11.C "Allowed network list").
export const ALLOWED_USDT_NETWORKS = (process.env.FIFO_USDT_NETWORKS ?? "TRC20,ERC20,BEP20")
  .split(",").map((n) => n.trim().toUpperCase()).filter(Boolean);

export function isAllowedNetwork(network?: string | null): boolean {
  return !!network && ALLOWED_USDT_NETWORKS.includes(network.toUpperCase());
}

// Lock an INR→USDT rate (INR per 1 USDT) with a source + timestamp. Prefers a live
// FX quote; falls back to a configured reference rate so the flow is demoable.
export async function lockUsdtRate(): Promise<{ rate: number; source: string; lockedAt: string }> {
  const lockedAt = new Date().toISOString();
  try {
    // getQuote gives target-per-source; INR→USDT would be a tiny decimal, so we
    // quote USDT→INR (INR per USDT) which matches the BRD sample (≈89.35).
    const q = await getQuote("USDT", "INR");
    if (q && q.rate_decimal > 1) return { rate: q.rate_decimal, source: "fx.getQuote", lockedAt };
  } catch { /* fall through to reference rate */ }
  const ref = Number(process.env.FIFO_USDT_INR_RATE ?? "89.35");
  return { rate: ref, source: "reference", lockedAt };
}

// USDT amount (major units, 2dp) for an INR amount in minor units at the locked rate.
export function computeUsdtAmount(amountMinorINR: bigint, rateInrPerUsdt: number): number {
  const inrMajor = Number(amountMinorINR) / 100;
  if (!rateInrPerUsdt || rateInrPerUsdt <= 0) return 0;
  return Math.round((inrMajor / rateInrPerUsdt) * 100) / 100;
}
