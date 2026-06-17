// FX quotes (BRD §10 P6).
//
// Lightweight lookup against fx_quotes. Production swaps to a streaming
// feed (REUTERS / EBS / on-chain oracles for crypto). The contract stays:
//   getQuote(from, to)  → { rate, spread_bps, expires_at }
//   convert(amountMinor, from, to)   → amountMinor in `to` currency

import { rows } from "@/lib/pg";
import { exponentOf } from "@/lib/money";

export interface QuoteResult {
  source_currency: string;
  target_currency: string;
  rate_decimal: number;
  spread_bps: number;
  quoted_at: string;
  expires_at: string;
  stale: boolean;
}

export async function getQuote(from: string, to: string): Promise<QuoteResult | null> {
  if (from.toUpperCase() === to.toUpperCase()) {
    return {
      source_currency: from, target_currency: to,
      rate_decimal: 1, spread_bps: 0,
      quoted_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
      stale: false,
    };
  }
  const r = await rows<any>("ledger", `
    SELECT source_currency, target_currency,
           rate_decimal::float AS rate_decimal,
           spread_bps, quoted_at, expires_at
      FROM fx_quotes
     WHERE source_currency = $1 AND target_currency = $2
     ORDER BY quoted_at DESC LIMIT 1
  `, [from.toUpperCase(), to.toUpperCase()]).catch(() => []);
  if (!r.length) return null;
  return { ...r[0], stale: new Date(r[0].expires_at).getTime() < Date.now() };
}

// Convert an amount in `from` currency (in MINOR units) to `to` currency
// (also MINOR units), applying the FX rate AND the spread.
//
//   target_major = source_major * rate * (1 - spread_bps/10000)
//   target_minor = round(target_major * 10^exp(to))
//
// Returns null if no quote.
export async function convertMinor(
  amountMinor: bigint | string | number, from: string, to: string,
): Promise<{ amount_minor: bigint; rate: number; spread_bps: number } | null> {
  if (from.toUpperCase() === to.toUpperCase()) {
    return { amount_minor: BigInt(String(amountMinor)), rate: 1, spread_bps: 0 };
  }
  const q = await getQuote(from, to);
  if (!q) return null;
  const fromExp = exponentOf(from);
  const toExp = exponentOf(to);
  const src = Number(amountMinor) / Math.pow(10, fromExp);
  const dstMajor = src * q.rate_decimal * (1 - q.spread_bps / 10000);
  const dstMinor = BigInt(Math.round(dstMajor * Math.pow(10, toExp)));
  return { amount_minor: dstMinor, rate: q.rate_decimal, spread_bps: q.spread_bps };
}
