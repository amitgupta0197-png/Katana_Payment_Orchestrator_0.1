// Which payment app a credit was received on.
//
// The information is already in every captured credit, in two different shapes depending on how
// it arrived, which is why no screen showed it: a screen-read stamps `bank` ("PAYTM", "GPAY",
// "AIRTEL"), while a push carries only the Android package that posted it — and that package name
// says "paisa.merchant" rather than anything resembling "GPay", so the parser's bank guess comes
// back empty for exactly the channel that produces most rows.
//
// So both are consulted, plus the ingestion source for the channels that are not an app at all
// (a merchant's mailbox, a signed gateway). One helper, so a badge on the provider dashboard and
// a column in the banker portal can never disagree about the same payment.

export interface PaymentAppInput {
  /** Set by the on-device screen reader: PAYTM | GPAY | AIRTEL, or a bank name from an SMS. */
  bank?: string | null;
  /** Android package that posted the notification, or an SMS sender / email address. */
  sender?: string | null;
  /** NOTIFICATION | ACCESSIBILITY | SMS | EMAIL | DEVICE | BANK_API | SIMULATED */
  source?: string | null;
}

export interface PaymentApp {
  /** Stable key for styling: GPAY | PAYTM | PHONEPE | AIRTEL | EMAIL | BANK | UNKNOWN */
  key: "GPAY" | "PAYTM" | "PHONEPE" | "BHARATPE" | "AIRTEL" | "EMAIL" | "BANK" | "UNKNOWN";
  /** What a human reads on the row. */
  label: string;
}

// Package fragments are matched rather than exact ids: the same app ships under more than one
// package (Paytm for Business is com.paytm.business on some builds, net.one97.paytm.merchant on
// others) and matching a fragment keeps a rename from blanking the badge.
const BY_PACKAGE: [RegExp, PaymentApp][] = [
  [/paisa\.merchant|paisa\.user|nbu\.paisa/i, { key: "GPAY", label: "Google Pay" }],
  [/paytm/i,                                  { key: "PAYTM", label: "Paytm" }],
  [/phonepe/i,                                { key: "PHONEPE", label: "PhonePe" }],
  [/bharatpe/i,                               { key: "BHARATPE", label: "BharatPe" }],
  [/apbl|airtel/i,                            { key: "AIRTEL", label: "Airtel" }],
];

const BY_BANK: Record<string, PaymentApp> = {
  GPAY: { key: "GPAY", label: "Google Pay" },
  PAYTM: { key: "PAYTM", label: "Paytm" },
  PHONEPE: { key: "PHONEPE", label: "PhonePe" },
  BHARATPE: { key: "BHARATPE", label: "BharatPe" },
  AIRTEL: { key: "AIRTEL", label: "Airtel" },
};

/** The app (or channel) a credit came in on. Never throws; unknown is a first-class answer. */
export function paymentAppOf(r: PaymentAppInput): PaymentApp {
  const bank = (r.bank ?? "").trim().toUpperCase();
  if (BY_BANK[bank]) return BY_BANK[bank];

  const sender = (r.sender ?? "").trim();
  for (const [re, app] of BY_PACKAGE) if (re.test(sender)) return app;

  const source = (r.source ?? "").trim().toUpperCase();
  if (source === "EMAIL") return { key: "EMAIL", label: "Email" };

  // A real bank name from an SMS header ("HDFC", "AXIS") is worth showing as itself — the money
  // arrived through the bank, not through a payment app.
  if (bank) return { key: "BANK", label: bank.charAt(0) + bank.slice(1).toLowerCase() };
  return { key: "UNKNOWN", label: "—" };
}

/**
 * Brand tint for the badge dot. Deliberately not the Badge component's semantic variants: those
 * mean success/warning/danger, and an app is not a verdict — a Paytm payment is not "a warning".
 */
export const PAYMENT_APP_DOT: Record<PaymentApp["key"], string> = {
  GPAY: "#4285f4",
  PAYTM: "#00b9f5",
  PHONEPE: "#5f259f",
  BHARATPE: "#00bab3",
  AIRTEL: "#e40000",
  EMAIL: "#8b8b8b",
  BANK: "#8b8b8b",
  UNKNOWN: "transparent",
};
