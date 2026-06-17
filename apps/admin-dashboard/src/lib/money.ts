// Money helpers (BRD §10 P6 acceptance:
//   "Amounts are stored as amount_minor with currency exponent.").
//
// Storing money as floats loses cents. Storing as numeric/decimal is fine
// for SQL but JS Number cannot safely represent 2^53 minor units across
// currencies like USDT (exponent 6) at large scale. The platform-wide
// rule: every persisted amount is a bigint of minor units PLUS a currency
// code. Conversions happen ONLY at the API edge.
//
// Use `toMinor(amount, currency)` when accepting human-typed amounts and
// `fromMinor(amount_minor, currency)` when serialising for UI / receipts.
// Do not do arithmetic in major units. Sum bigints, then convert.

export type Currency =
  | "INR" | "USD" | "EUR" | "GBP" | "AED" | "SGD" | "JPY"
  | "USDT" | "USDC" | "BTC" | "ETH" | "BHD";

// ISO-4217 fractional digits + crypto minor-unit exponents (Tether: 6, BTC: 8).
const EXPONENT: Record<Currency, number> = {
  INR: 2, USD: 2, EUR: 2, GBP: 2, AED: 2, SGD: 2,
  JPY: 0,        // zero-decimal fiat
  BHD: 3,        // three-decimal fiat
  USDT: 6, USDC: 6,
  BTC: 8, ETH: 8,
};

export function exponentOf(currency: string): number {
  const e = EXPONENT[currency.toUpperCase() as Currency];
  if (e === undefined) throw new Error(`unknown currency: ${currency}`);
  return e;
}

// "12.34", 12.34, 1234 all -> 1234n minor units for INR.
// Floats are accepted but never trusted at >15 significant digits.
export function toMinor(amount: number | string, currency: string): bigint {
  const e = exponentOf(currency);
  const str = typeof amount === "string" ? amount.trim() : amount.toString();
  if (!/^-?\d+(\.\d+)?$/.test(str)) throw new Error(`invalid amount: ${amount}`);
  const [whole, frac = ""] = str.split(".");
  const paddedFrac = (frac + "0".repeat(e)).slice(0, e);
  const sign = whole.startsWith("-") ? -1n : 1n;
  const absWhole = whole.replace(/^-/, "");
  return sign * (BigInt(absWhole) * (10n ** BigInt(e)) + BigInt(paddedFrac || "0"));
}

// 1234n + INR -> "12.34". Returns a STRING (never a float) to avoid
// JSON.stringify rounding when amounts cross JS Number's safe range.
export function fromMinor(amountMinor: bigint | string | number, currency: string): string {
  const e = exponentOf(currency);
  const v = typeof amountMinor === "bigint" ? amountMinor : BigInt(amountMinor as any);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const div = 10n ** BigInt(e);
  const whole = abs / div;
  const frac = abs % div;
  if (e === 0) return (neg ? "-" : "") + whole.toString();
  const fracStr = frac.toString().padStart(e, "0");
  return (neg ? "-" : "") + whole.toString() + "." + fracStr;
}

// Sum bigint amounts safely. Throws on currency mismatch.
export function sumMinor(items: { amount_minor: bigint | string | number; currency: string }[]): {
  amount_minor: bigint; currency: string;
} {
  if (!items.length) throw new Error("sumMinor: empty list");
  const currency = items[0].currency;
  let total = 0n;
  for (const it of items) {
    if (it.currency !== currency)
      throw new Error(`sumMinor: currency mismatch ${currency} vs ${it.currency}`);
    total += typeof it.amount_minor === "bigint" ? it.amount_minor : BigInt(it.amount_minor as any);
  }
  return { amount_minor: total, currency };
}

// Apply bps fee (basis points = 1/10000). Rounded to nearest minor unit.
export function applyBps(amountMinor: bigint, bps: number): bigint {
  const bpsBig = BigInt(Math.trunc(bps));
  // half-up rounding
  const numer = amountMinor * bpsBig;
  const denom = 10000n;
  const half = denom / 2n;
  const rounded = numer >= 0n
    ? (numer + half) / denom
    : -((-numer + half) / denom);
  return rounded;
}

// Format with currency code: 1234n + INR -> "INR 12.34"
export function formatMoney(amountMinor: bigint | string | number, currency: string): string {
  return `${currency} ${fromMinor(amountMinor, currency)}`;
}
