// The words merchants and bankers read in their portals (lib/payment-story, components/portal).
// PURE. One vocabulary for every status a portal shows, the same words the support assistant
// uses: a payment is Paid, Waiting, Failed or Expired; a payout is Sent, On its way, On hold,
// Failed, Stopped or Returned. Internal names (VPA, RRN, Captured, COMPLETED…) never reach them.

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

export interface PlainStatus { word: string; tone: Tone; meaning: string }

const PAYMENT: Record<string, PlainStatus> = {
  SUCCESS: { word: "Paid", tone: "success", meaning: "The money came in." },
  PENDING: { word: "Waiting", tone: "info", meaning: "Waiting for the customer to pay." },
  FAILED: { word: "Failed", tone: "danger", meaning: "The payment did not go through." },
  EXPIRED: { word: "Expired", tone: "neutral", meaning: "No payment came in time." },
  REFUNDED: { word: "Refunded", tone: "neutral", meaning: "The money was sent back to the customer." },
};

/** Every pay-in status Katana stores or reports, in the four (five) words merchants see. */
export function plainPaymentStatus(raw: string | null | undefined): PlainStatus {
  const s = String(raw ?? "").trim().toUpperCase();
  if (["SUCCESS", "SUCCEEDED", "CAPTURED", "PAID", "CONFIRMED", "SETTLED", "COMPLETED"].includes(s)) return PAYMENT.SUCCESS;
  if (["FAILED", "FAILURE", "DECLINED", "ERROR", "REJECTED", "CANCELLED", "CANCELED"].includes(s)) return PAYMENT.FAILED;
  if (["EXPIRED", "TIMEOUT", "TIMED_OUT", "ABANDONED"].includes(s)) return PAYMENT.EXPIRED;
  if (["REFUNDED", "REVERSED", "PARTIALLY_REFUNDED"].includes(s)) return PAYMENT.REFUNDED;
  return PAYMENT.PENDING;
}

const PAYOUT: Record<string, PlainStatus> = {
  SUCCESS: { word: "Sent", tone: "success", meaning: "The money reached the bank account." },
  PROCESSING: { word: "On its way", tone: "info", meaning: "The bank is processing it." },
  ON_HOLD: { word: "On hold", tone: "warning", meaning: "Waiting for a second approval at Katana." },
  FAILED: { word: "Failed", tone: "danger", meaning: "The bank did not accept it. No money left." },
  REJECTED: { word: "Stopped", tone: "danger", meaning: "Katana did not send it." },
  REVERSED: { word: "Returned", tone: "warning", meaning: "The bank sent the money back after it was sent." },
};

/** A payout's internal or public status in merchants' words. */
export function plainPayoutStatus(raw: string | null | undefined): PlainStatus {
  const s = String(raw ?? "").trim().toUpperCase();
  if (s === "COMPLETED" || s === "SETTLED" || s === "SUCCESS") return PAYOUT.SUCCESS;
  if (s === "HOLD" || s === "ON_HOLD") return PAYOUT.ON_HOLD;
  if (s === "FAILED") return PAYOUT.FAILED;
  if (s === "REJECTED" || s === "CANCELLED") return PAYOUT.REJECTED;
  if (s === "REVERSED") return PAYOUT.REVERSED;
  return PAYOUT.PROCESSING;
}

/** "Rs 1,23,456" or "Rs 499.50": Indian grouping, paise only when there are some. */
export function rupees(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  const whole = Number.isInteger(Math.round(v * 100) / 100);
  return `Rs ${v.toLocaleString("en-IN", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** "5:19 AM", with "3 Oct, " in front when it is not today (India time). */
export function istTime(d: string | Date | null | undefined, now: Date = new Date()): string {
  if (!d) return "";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "";
  const day = (x: Date) => x.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
  const time = t.toLocaleTimeString("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
  return day(t) === day(now) ? time : `${day(t)}, ${time}`;
}

/** Words that mean something only inside Katana, and what a merchant calls them. */
export const PLAIN_TERMS: Record<string, string> = {
  VPA: "UPI ID",
  RRN: "bank reference (UTR)",
  "Credits proven": "Confirmed by bank",
  "Awaiting RRN": "Waiting for bank reference",
  Captured: "Paid",
};
