// How a banker is paid on P2P: exactly one method, chosen by staff (merchant 0027,
// merchants.p2p_method; storage in lib/p2p-method-store). Pure.
//
//   UPI_ID    the customer pays the banker's own UPI ID; a capture phone (Paytm, PhonePe, GPay,
//             Airtel, Pine Labs, bank SMS) sees the credit and the order is confirmed
//   BHARATPE  the customer pays the banker's BharatPe QR; the Katana agent reads BharatPe on the
//             banker's phone and posts each payment signed with the BharatPe MID key
//   PAYATOM   PayAtom issues the payment (UPI link / QR) and confirms it
//
// null = not chosen: the order path routes as it always did (a P2P processor account if the
// banker's first account is one, else its UPI ID). Only the chosen method takes P2P orders.

export type P2pMethod = "UPI_ID" | "BHARATPE" | "PAYATOM";
export const P2P_METHODS: P2pMethod[] = ["UPI_ID", "BHARATPE", "PAYATOM"];

export const P2P_METHOD_INFO: Record<P2pMethod, { title: string; line: string; confirmedBy: string; needs: string[] }> = {
  UPI_ID: {
    title: "UPI ID / QR",
    line: "Scan and pay: customers pay the banker's own UPI ID or QR (Google Pay, PhonePe, Paytm, other).",
    confirmedBy: "A phone with the Katana agent reads the payment app or bank SMS.",
    needs: ["The UPI ID customers pay", "A capture phone online"],
  },
  BHARATPE: {
    title: "BharatPe",
    line: "Scan and pay: customers pay the banker's BharatPe QR.",
    confirmedBy: "The Katana agent reads BharatPe on the banker's phone and sends each payment with its UTR.",
    needs: ["A BharatPe MID (its UPI ID becomes the one customers pay)", "The MID's key in the agent, on a phone that is online"],
  },
  PAYATOM: {
    title: "PayAtom",
    line: "Scan, pay and verify (quasi): PayAtom gives the customer the payment link and QR.",
    confirmedBy: "PayAtom confirms each payment to Katana. No phone needed.",
    needs: ["A PayAtom account set to P2P (money lands with the banker)"],
  },
};

/**
 * The two kinds of P2P (Katana's banker model): SCAN_PAY — the customer scans the banker's own
 * static QR and the capture phone confirms it (UPI_ID, BHARATPE); QUASI — "scan, pay and verify",
 * also called P2P intent: a processor issues the payment link, the money still lands with the
 * banker, and the processor verifies it (PAYATOM).
 */
export type P2pKind = "SCAN_PAY" | "QUASI";
export const P2P_KIND_OF: Record<P2pMethod, P2pKind> = { UPI_ID: "SCAN_PAY", BHARATPE: "SCAN_PAY", PAYATOM: "QUASI" };
export const P2P_KIND_INFO: Record<P2pKind, { title: string; line: string }> = {
  SCAN_PAY: { title: "Scan and pay", line: "The customer scans the banker's own QR and pays. A phone with the Katana agent confirms it." },
  QUASI: { title: "Scan, pay and verify", line: "Quasi channel (P2P intent): a processor gives the customer the payment link, the money lands with the banker, and the processor verifies it." },
};

/** The payment app a scan-and-pay banker's QR belongs to (merchant 0028, merchants.p2p_app). */
export type P2pApp = "BHARATPE" | "GPAY" | "PHONEPE" | "PAYTM" | "OTHER";
export const P2P_APPS: P2pApp[] = ["BHARATPE", "GPAY", "PHONEPE", "PAYTM", "OTHER"];
export const P2P_APP_INFO: Record<P2pApp, { title: string; agent: string }> = {
  BHARATPE: { title: "BharatPe", agent: "BharatPe for Business" },
  GPAY: { title: "Google Pay", agent: "Google Pay for Business" },
  PHONEPE: { title: "PhonePe", agent: "PhonePe for Business" },
  PAYTM: { title: "Paytm", agent: "Paytm for Business" },
  OTHER: { title: "Other static QR", agent: "bank SMS / Airtel / Pine Labs" },
};
export function asP2pApp(v: unknown): P2pApp | null {
  return typeof v === "string" && (P2P_APPS as string[]).includes(v) ? (v as P2pApp) : null;
}
/** The method a scan-and-pay app runs on: BharatPe has its own (MID key); every other QR is a UPI ID. */
export function methodForApp(app: P2pApp): P2pMethod {
  return app === "BHARATPE" ? "BHARATPE" : "UPI_ID";
}

export function asP2pMethod(v: unknown): P2pMethod | null {
  return typeof v === "string" && (P2P_METHODS as string[]).includes(v) ? (v as P2pMethod) : null;
}

/** What is set up for a banker's P2P today, whichever method is chosen. */
export interface P2pFacts {
  /** The UPI ID customers pay (katana_pay.settlement_vpa), if any. */
  upiId: string | null;
  /** An ACTIVE BharatPe MID whose UPI ID is the one customers pay. */
  bharatpeMid: { label: string; env: "TEST" | "PROD" } | null;
  /** Any BharatPe MID at all (active or paused, any UPI ID). */
  bharatpeAny: number;
  /** The banker's first payment account is PayAtom on P2P. */
  payatomP2p: { env: string } | null;
  /** Capture phones: enrolled, and online with permissions now. */
  phones: { enrolled: number; online: number };
}

/**
 * The method a banker that nobody chose for is effectively on, from what routing does today:
 * a P2P processor account wins, else the UPI ID (BharatPe when it is a BharatPe MID's).
 */
export function inferP2pMethod(f: P2pFacts): P2pMethod | null {
  if (f.payatomP2p) return "PAYATOM";
  if (f.bharatpeMid) return "BHARATPE";
  if (f.upiId) return "UPI_ID";
  return null;
}

/**
 * May a P2P order go to a P2P processor account (PayAtom on P2P)? Only when that is the method,
 * or when nothing was chosen (the old routing).
 */
export function p2pProcessorAllowed(method: P2pMethod | null): boolean {
  return method === null || method === "PAYATOM";
}

export interface P2pStep { key: string; label: string; done: boolean; required: boolean }

/** The setup steps of a method, ticked from facts. `ready` = every required step done. */
export function p2pSteps(method: P2pMethod, f: P2pFacts): { steps: P2pStep[]; ready: boolean } {
  const steps: P2pStep[] =
    method === "UPI_ID" ? [
      { key: "UPI_ID", label: "UPI ID customers pay", done: !!f.upiId, required: true },
      { key: "PHONE", label: "Capture phone online", done: f.phones.online > 0, required: false },
    ]
    : method === "BHARATPE" ? [
      { key: "BHARATPE_MID", label: "BharatPe MID connected", done: !!f.bharatpeMid, required: true },
      { key: "PHONE", label: "Agent phone online", done: f.phones.online > 0, required: false },
    ]
    : [
      { key: "PAYATOM", label: "PayAtom account on P2P", done: !!f.payatomP2p, required: true },
    ];
  return { steps, ready: steps.every((s) => s.done || !s.required) };
}

/** Whether a banker can take a live P2P order on its method (null method: the old rule). */
export function p2pReady(method: P2pMethod | null, f: P2pFacts): boolean {
  if (method === null) return !!f.upiId || !!f.payatomP2p;
  return p2pSteps(method, f).ready;
}

/**
 * What switching from one method to another does, in plain words, for the confirm dialog.
 * Nothing is deleted: the old method's setup stays saved and is simply not used.
 */
export function switchSummary(from: P2pMethod | null, to: P2pMethod, f: P2pFacts): string[] {
  const out: string[] = [`New P2P orders are paid through ${P2P_METHOD_INFO[to].title}.`];
  if (from && from !== to) out.push(`${P2P_METHOD_INFO[from].title} stays saved but takes no new orders. Orders already open finish as they started.`);
  if (to === "BHARATPE" && f.upiId && !f.bharatpeMid) out.push(`Connecting a BharatPe MID makes its UPI ID the one customers pay, in place of ${f.upiId}.`);
  if (!p2pSteps(to, f).ready) out.push(`${P2P_METHOD_INFO[to].title} is not set up yet: live P2P orders are refused until it is.`);
  return out;
}
