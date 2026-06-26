// PoolPay S2S pay-in — sandbox dispatcher.
//
// Flow modelled: order create -> deeplink response (Paytm / PhonePe / generic UPI
// + QR) -> customer pays -> status enquiry / callback -> final status.
//
// This is the SANDBOX implementation: createPoolPayOrder() synthesises a
// deterministic deeplink response and enquirePoolPayStatus() advances the order
// over time so the end-to-end flow is demoable without live PoolPay credentials.
// For the real integration, replace the bodies with signed HTTP calls to
// PoolPay's S2S /order/create and /order/status endpoints and parse their
// deeplink payload — the shapes below already match that contract.

const PAYEE_VPA = "poolpay.sandbox@upi"; // gateway collect VPA (payee)
const PAYEE_NAME = "PoolPay";

export interface DeepLinks {
  paytm: string;
  phonepe: string;
  upi: string; // generic UPI intent (also used as the QR payload)
}

// Build the UPI parameter string shared by every app deeplink and the QR.
export function buildUpiQuery(opts: { payeeVpa?: string; orderId: string; amount: number; note?: string }): string {
  const params = new URLSearchParams({
    pa: opts.payeeVpa ?? PAYEE_VPA,
    pn: PAYEE_NAME,
    tr: opts.orderId,
    am: opts.amount.toFixed(2),
    cu: "INR",
    tn: opts.note ?? `Order ${opts.orderId}`,
  });
  return params.toString();
}

export function buildDeeplinks(query: string): DeepLinks {
  return {
    paytm: `paytmmp://pay?${query}`,
    phonepe: `phonepe://pay?${query}`,
    upi: `upi://pay?${query}`,
  };
}

// Sandbox status decision. Deterministic on amount (last two minor digits) so a
// tester can force outcomes, with a time-based settle for the happy path.
//   ...13  -> FAILED (customer declined / U30)
//   ...11  -> EXPIRED (collect request lapsed / U69)
//   else   -> PENDING for ~8s, then SUCCESS (collected)
export function decidePoolPayStatus(
  amountMinor: number,
  ageSeconds: number,
): { status: "PENDING" | "SUCCESS" | "FAILED" | "EXPIRED"; response_code: string } {
  if (amountMinor % 100 === 13) return { status: "FAILED", response_code: "U30" };
  if (amountMinor % 100 === 11) return { status: "EXPIRED", response_code: "U69" };
  if (ageSeconds >= 8) return { status: "SUCCESS", response_code: "00" };
  return { status: "PENDING", response_code: "U17" };
}

export const POOLPAY_TERMINAL = new Set(["SUCCESS", "SUCCEEDED", "FAILED", "EXPIRED"]);

// Stable 12-digit RRN derived from the order id (so repeated enquiries match).
export function genRrn(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 1_000_000_000_000;
  return h.toString().padStart(12, "0");
}
