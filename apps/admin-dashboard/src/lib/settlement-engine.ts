// Settlement Engine, phase 1 — the rules. PURE (no `pg`): the store (settlement-engine-store)
// reads and writes, this decides.
//
// The model today: a customer's money lands with the BANKER (its own UPI ID or its own gateway
// account), and the banker owes it to its MERCHANT (the `providers` row). The ledger records that
// per banker, in INR paise:
//
//   ASSETS.HELD_BY_BANKER.<banker>            money for merchants sitting with the banker
//   LIABILITIES.MERCHANT_PAYABLE.<banker>     owed to the merchant, not yet raised for settlement
//   LIABILITIES.MERCHANT_RESERVE.<banker>     rolling reserve withheld at settlement
//   LIABILITIES.SETTLEMENT_IN_TRANSIT.<banker> raised and being paid, not yet confirmed
//   INCOME.SETTLEMENT_FEE.<LAYER>.<banker>    rate-card charges (UPLINE / KATANA / DOWNLINE / FIXED)
//   LIABILITIES.GST_PAYABLE.<banker>          GST on those charges
//   ASSETS.TDS_RECEIVABLE.<banker>            TDS the merchant withholds on the charges
//
// A pay-in paid:          D HELD_BY_BANKER  / C MERCHANT_PAYABLE              (ledger-sync)
// A chargeback debit:     D MERCHANT_PAYABLE / C HELD_BY_BANKER               (ledger-sync)
// Settlement INITIATED:   D MERCHANT_PAYABLE gross, D TDS_RECEIVABLE tds
//                         / C IN_TRANSIT net, C RESERVE, C fees, C GST
// Settlement SETTLED:     D IN_TRANSIT net / C HELD_BY_BANKER net             (the banker paid)
// FAILED / REVERSED:      the journals above, reversed line for line
// Reserve released:       D MERCHANT_RESERVE / C MERCHANT_PAYABLE
//
// A Katana escrow account and Katana-paid rails slot in later as another HELD_BY_* asset and
// another way to reach IN_TRANSIT; the instruction, the arithmetic and the states stay.

import type { JournalLine } from "@/lib/ledger";

// ── Config ──────────────────────────────────────────────────────────────────────────────────

export const SETTLEMENT_TIMINGS = ["INSTANT", "ON_DEMAND", "T0", "T1", "T2", "WEEKLY"] as const;
export type SettlementTiming = (typeof SETTLEMENT_TIMINGS)[number];

export interface SettlementConfigBody {
  timing: SettlementTiming;
  /** WEEKLY: the IST weekday it runs on, 0 = Sunday. */
  weekday?: number | null;
  /** The IST hour from which the day's cycle is due (T0: the day's cut-off). Default 10 (T0: 22). */
  run_hour_ist?: number | null;
  currency: "INR";
  /** Below this a cycle raises nothing and the amount waits for the next one. */
  min_payout_minor: number;
  /** Above this a cycle raises only this much; the rest waits. Null = no cap. */
  max_payout_minor?: number | null;
  /** Rolling reserve: share of each settlement withheld, and for how long. */
  reserve_bps: number;
  reserve_hold_days: number;
  /** TDS the merchant withholds on the charges (excl. GST), in bps. 0 = none. */
  tds_bps: number;
  /** Where the merchant is paid: a provider_beneficiary_accounts row, and fallbacks in order. */
  beneficiary_id: string | null;
  fallback_beneficiary_ids?: string[];
  transfer_mode: "IMPS" | "NEFT" | "RTGS" | "UPI";
  /** The merchant may also ask for a payout of its available balance at any time. */
  allow_on_demand?: boolean;
}

/** Why a config body cannot be saved, or null. */
export function configProblem(b: Partial<SettlementConfigBody>): string | null {
  if (!b.timing || !(SETTLEMENT_TIMINGS as readonly string[]).includes(b.timing)) return "timing must be one of " + SETTLEMENT_TIMINGS.join(", ");
  if (b.timing === "WEEKLY" && !(Number.isInteger(b.weekday) && b.weekday! >= 0 && b.weekday! <= 6)) return "a weekly cycle needs a weekday (0 = Sunday … 6 = Saturday)";
  if (b.run_hour_ist != null && !(Number.isInteger(b.run_hour_ist) && b.run_hour_ist >= 0 && b.run_hour_ist <= 23)) return "run hour must be 0-23 (IST)";
  if (b.currency !== "INR") return "only INR settlement is built (phase 1)";
  if (!(Number.isInteger(b.min_payout_minor) && b.min_payout_minor! >= 0)) return "minimum payout must be whole paise, 0 or more";
  if (b.max_payout_minor != null && !(Number.isInteger(b.max_payout_minor) && b.max_payout_minor > 0 && b.max_payout_minor >= (b.min_payout_minor ?? 0))) return "maximum payout must be above the minimum";
  for (const [k, v, hi] of [["reserve_bps", b.reserve_bps, 5000], ["tds_bps", b.tds_bps, 2000]] as const)
    if (!(Number.isInteger(v) && v! >= 0 && v! <= hi)) return `${k} must be 0-${hi} basis points`;
  if (!(Number.isInteger(b.reserve_hold_days) && b.reserve_hold_days! >= 0 && b.reserve_hold_days! <= 365)) return "reserve hold must be 0-365 days";
  if ((b.reserve_bps ?? 0) > 0 && (b.reserve_hold_days ?? 0) === 0) return "a reserve needs a hold period";
  if (!["IMPS", "NEFT", "RTGS", "UPI"].includes(b.transfer_mode ?? "")) return "transfer mode must be IMPS, NEFT, RTGS or UPI";
  if (b.transfer_mode === "RTGS" && (b.min_payout_minor ?? 0) < 2_00_000_00) return "RTGS takes ₹2,00,000 or more: set the minimum payout to at least that";
  return null;
}

// ── Cycles (IST) ────────────────────────────────────────────────────────────────────────────

const IST_MS = 5.5 * 3600_000;
/** The IST calendar day of an instant, as YYYY-MM-DD. */
export const istDay = (t: Date): string => new Date(t.getTime() + IST_MS).toISOString().slice(0, 10);
/** 00:00 IST of a YYYY-MM-DD day, as an instant. */
export const istMidnight = (day: string): Date => new Date(Date.parse(`${day}T00:00:00Z`) - IST_MS);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

export interface Cycle {
  /** Unique per banker and cycle: the instruction's idempotency key is built from it. */
  key: string;
  /** Pay-ins paid up to (not including) this instant are settled by this cycle. */
  cutoff: Date;
}

/**
 * The cycle due at `now` under a config, or null when none is due. Calendar days in IST (NEFT,
 * IMPS and UPI run every day); a cycle is due from its run hour and its key makes it run once.
 *   T0      paid today up to the run hour (default 22:00) — settled today
 *   T1 / T2 paid up to midnight starting yesterday / the day before — settled today
 *   WEEKLY  paid up to midnight starting today — settled on the weekday
 *   INSTANT everything paid so far, every run (key per 5 minutes)
 *   ON_DEMAND never by itself
 */
export function dueCycle(b: SettlementConfigBody, now: Date): Cycle | null {
  const today = istDay(now);
  const hourNow = new Date(now.getTime() + IST_MS).getUTCHours();
  const runHour = b.run_hour_ist ?? (b.timing === "T0" ? 22 : 10);
  switch (b.timing) {
    case "ON_DEMAND": return null;
    case "INSTANT": {
      const slot = new Date(Math.floor(now.getTime() / 300_000) * 300_000);
      return { key: `INSTANT:${slot.toISOString().slice(0, 16)}`, cutoff: now };
    }
    case "T0":
      if (hourNow < runHour) return null;
      return { key: `T0:${today}`, cutoff: new Date(istMidnight(today).getTime() + runHour * 3600_000) };
    case "T1":
      if (hourNow < runHour) return null;
      return { key: `T1:${today}`, cutoff: istMidnight(today) };
    case "T2":
      if (hourNow < runHour) return null;
      return { key: `T2:${today}`, cutoff: istMidnight(addDays(today, -1)) };
    case "WEEKLY": {
      const dow = new Date(Date.parse(`${today}T00:00:00Z`)).getUTCDay();
      if (dow !== b.weekday || hourNow < runHour) return null;
      return { key: `WEEKLY:${today}`, cutoff: istMidnight(today) };
    }
  }
}

// ── Amounts (paise, integers only) ──────────────────────────────────────────────────────────

/** A rate-card rule (provider_settlement_rules) in the form the arithmetic needs. */
export interface RateCard {
  id: string | null; version: number | null;
  upline_bps: number; katana_bps: number; downline_bps: number; gst_bps: number;
  fixed_fee_minor: number; min_charge_minor: number | null; max_charge_minor: number | null;
}
export const NO_RATE_CARD: RateCard = {
  id: null, version: null, upline_bps: 0, katana_bps: 0, downline_bps: 0, gst_bps: 0,
  fixed_fee_minor: 0, min_charge_minor: null, max_charge_minor: null,
};

/** bps of an amount, rounded half up. */
export const bpsOf = (amount: bigint, bps: number): bigint => (amount * BigInt(bps) + 5000n) / 10000n;

export interface SettlementAmounts {
  gross: bigint; reserve: bigint;
  upline: bigint; katana: bigint; downline: bigint; fixed: bigint;
  charges: bigint;        // upline + katana + downline + fixed, after the min / max clamp
  gst: bigint; tds: bigint;
  net: bigint;            // gross − reserve − charges − gst + tds: what the merchant receives
}

/**
 * The breakdown of one settlement. The rate card's layers are bps of gross, plus its fixed fee;
 * the sum is clamped to [min, max] (a clamp scales the parts in proportion, the remainder on the
 * largest); GST is on the clamped charges; TDS is the merchant's withholding on the charges
 * excluding GST, which it keeps back from what it pays (so it adds to net). A settlement whose
 * deductions would exceed it is refused rather than paid at zero.
 */
export function settlementAmounts(gross: bigint, card: RateCard, b: Pick<SettlementConfigBody, "reserve_bps" | "tds_bps">): SettlementAmounts {
  if (gross <= 0n) throw new Error("gross must be positive");
  const parts = {
    upline: bpsOf(gross, card.upline_bps), katana: bpsOf(gross, card.katana_bps),
    downline: bpsOf(gross, card.downline_bps), fixed: BigInt(card.fixed_fee_minor),
  };
  const sum = parts.upline + parts.katana + parts.downline + parts.fixed;
  let charges = sum;
  if (card.min_charge_minor != null && charges < BigInt(card.min_charge_minor)) charges = BigInt(card.min_charge_minor);
  if (card.max_charge_minor != null && charges > BigInt(card.max_charge_minor)) charges = BigInt(card.max_charge_minor);
  if (charges !== sum) {
    if (sum === 0n) { parts.fixed = charges; }   // only a minimum charge: it is the fixed part
    else {
      const keys = ["upline", "katana", "downline", "fixed"] as const;
      let left = charges;
      for (const k of keys) { parts[k] = (parts[k] * charges) / sum; left -= parts[k]; }
      const big = keys.reduce((m, k) => (parts[k] > parts[m] ? k : m), "katana" as (typeof keys)[number]);
      parts[big] += left;
    }
  }
  const gst = bpsOf(charges, card.gst_bps);
  const tds = bpsOf(charges, b.tds_bps);
  const reserve = bpsOf(gross, b.reserve_bps);
  const net = gross - reserve - charges - gst + tds;
  if (net <= 0n) throw new Error(`deductions (${gross - net}) leave nothing to settle on ${gross}`);
  return { gross, reserve, ...parts, charges, gst, tds, net };
}

/**
 * How much a cycle settles: the payable balance less what was paid after the cut-off (that waits
 * for its own cycle), capped at the maximum; nothing when under the minimum.
 */
export function cycleGross(payable: bigint, paidAfterCutoff: bigint, b: Pick<SettlementConfigBody, "min_payout_minor" | "max_payout_minor">): bigint {
  let g = payable - paidAfterCutoff;
  if (g <= 0n) return 0n;
  if (b.max_payout_minor != null && g > BigInt(b.max_payout_minor)) g = BigInt(b.max_payout_minor);
  return g < BigInt(b.min_payout_minor) ? 0n : g;
}

// ── States ──────────────────────────────────────────────────────────────────────────────────

export const INSTRUCTION_STATES = ["PENDING", "INITIATED", "IN_TRANSIT", "SETTLED", "FAILED", "REVERSED", "HELD", "CANCELLED"] as const;
export type InstructionState = (typeof INSTRUCTION_STATES)[number];

const NEXT: Record<InstructionState, InstructionState[]> = {
  PENDING: ["INITIATED", "HELD", "CANCELLED"],
  INITIATED: ["IN_TRANSIT", "SETTLED", "FAILED", "HELD"],
  IN_TRANSIT: ["SETTLED", "FAILED", "HELD"],
  HELD: ["PENDING", "INITIATED", "IN_TRANSIT", "FAILED", "CANCELLED"],
  SETTLED: ["REVERSED"],
  FAILED: [], REVERSED: [], CANCELLED: [],
};

/** Whether a move is allowed. HELD goes back only to the state it was held from (or ends). */
export function canMove(from: InstructionState, to: InstructionState, heldFrom?: InstructionState | null): boolean {
  if (!NEXT[from].includes(to)) return false;
  if (from === "HELD" && ["PENDING", "INITIATED", "IN_TRANSIT"].includes(to)) return to === (heldFrom ?? "PENDING");
  if (from === "HELD" && to === "CANCELLED") return heldFrom === "PENDING" || heldFrom == null;
  if (from === "HELD" && to === "FAILED") return heldFrom === "INITIATED" || heldFrom === "IN_TRANSIT";
  return true;
}
export const isFinal = (s: InstructionState) => NEXT[s].length === 0;

/**
 * The instruction state a banker→merchant settlement request's status means (provider 0005).
 * null = no change for the engine.
 */
export function stateForBranchStatus(status: string): InstructionState | null {
  switch (status) {
    case "PAID": case "UTR_SUBMITTED": case "PARTIALLY_PAID": case "USDT_TRANSFERRED": return "IN_TRANSIT";
    case "VERIFIED": case "RECONCILED": return "SETTLED";
    case "REJECTED": case "CANCELLED": case "FAILED": case "INVALID_BENEFICIARY": case "INSUFFICIENT_BALANCE": return "FAILED";
    case "REVERSED": return "REVERSED";
    case "ON_HOLD": case "COMPLIANCE_REVIEW": case "ESCALATED": return "HELD";
    default: return null;   // REQUESTED, ACCEPTED, PROCESSING, REVIEW, CORRECTION_REQUIRED: still initiated
  }
}

// ── Journals ────────────────────────────────────────────────────────────────────────────────

export const acct = {
  held: (b: string) => `ASSETS.HELD_BY_BANKER.${b}`,
  payable: (b: string) => `LIABILITIES.MERCHANT_PAYABLE.${b}`,
  reserve: (b: string) => `LIABILITIES.MERCHANT_RESERVE.${b}`,
  transit: (b: string) => `LIABILITIES.SETTLEMENT_IN_TRANSIT.${b}`,
  fee: (layer: "UPLINE" | "KATANA" | "DOWNLINE" | "FIXED", b: string) => `INCOME.SETTLEMENT_FEE.${layer}.${b}`,
  gst: (b: string) => `LIABILITIES.GST_PAYABLE.${b}`,
  tds: (b: string) => `ASSETS.TDS_RECEIVABLE.${b}`,
};

const line = (account_code: string, side: "D" | "C", amount: bigint, currency = "INR"): JournalLine[] =>
  amount > 0n ? [{ account_code, side, amount_minor: amount, currency }] : [];

/** Money for the merchant arrives with the banker (a paid pay-in) — or leaves it (a chargeback). */
export function collectedLines(banker: string, amount: bigint): JournalLine[] {
  return [...line(acct.held(banker), "D", amount), ...line(acct.payable(banker), "C", amount)];
}
export function chargebackLines(banker: string, amount: bigint): JournalLine[] {
  return [...line(acct.payable(banker), "D", amount), ...line(acct.held(banker), "C", amount)];
}
/** A settlement the merchant raised and the banker paid outside the engine (verified). */
export function manualSettledLines(banker: string, amount: bigint): JournalLine[] {
  return chargebackLines(banker, amount);
}

export function initiatedLines(banker: string, a: SettlementAmounts): JournalLine[] {
  return [
    ...line(acct.payable(banker), "D", a.gross),
    ...line(acct.tds(banker), "D", a.tds),
    ...line(acct.transit(banker), "C", a.net),
    ...line(acct.reserve(banker), "C", a.reserve),
    ...line(acct.fee("UPLINE", banker), "C", a.upline),
    ...line(acct.fee("KATANA", banker), "C", a.katana),
    ...line(acct.fee("DOWNLINE", banker), "C", a.downline),
    ...line(acct.fee("FIXED", banker), "C", a.fixed),
    ...line(acct.gst(banker), "C", a.gst),
  ];
}
export function settledLines(banker: string, net: bigint): JournalLine[] {
  return [...line(acct.transit(banker), "D", net), ...line(acct.held(banker), "C", net)];
}
export function reserveReleaseLines(banker: string, amount: bigint): JournalLine[] {
  return [...line(acct.reserve(banker), "D", amount), ...line(acct.payable(banker), "C", amount)];
}
/** The same lines with every side swapped: a reversal never edits, it posts the mirror. */
export function reversed(lines: JournalLine[]): JournalLine[] {
  return lines.map((l) => ({ ...l, side: l.side === "D" ? "C" : "D" }));
}

/** Rupees (numeric / float from the database) to paise, exactly. */
export function paiseOf(rupees: number | string): bigint {
  const s = String(rupees).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`not an amount: ${s}`);
  const [w, f = ""] = s.replace(/^-/, "").split(".");
  const p = BigInt(w) * 100n + BigInt((f + "00").slice(0, 2)) + (f.length > 2 && Number(f[2]) >= 5 ? 1n : 0n);
  return s.startsWith("-") ? -p : p;
}
