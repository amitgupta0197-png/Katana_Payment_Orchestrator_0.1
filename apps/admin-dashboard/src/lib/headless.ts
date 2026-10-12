// Quasi-headless checkout (P2P method HEADLESS): pure rules. Storage and the PSP call are in
// lib/headless-store; the page is app/pay/[orderId]/checkout.
//
// The merchant's app opens Katana's hosted checkout (/pay/{id}/checkout) in a WebView with no
// browser chrome. The customer picks PhonePe or Paytm (pre-selected from their own UPI ID's
// handle), confirms the amount and taps Pay: Katana asks that PSP — the banker's own PG account,
// saved for P2P — for the UPI intent, and the page fires the app link. The app's own deep link
// (phonepe:// / paytmmp:// / upi://) leaves the WebView: the merchant's native shell hands it to
// the OS. The PSP's webhook confirms the order (the source of truth); the page's result is UX only.

export type HeadlessPsp = "PHONEPE" | "PAYTM";
export const HEADLESS_PSPS: HeadlessPsp[] = ["PHONEPE", "PAYTM"];

/** What the customer sees: the UPI app's name (an app, not the PG). */
export const HEADLESS_PSP_INFO: Record<HeadlessPsp, { app: string; scheme: string }> = {
  PHONEPE: { app: "PhonePe", scheme: "phonepe" },
  PAYTM: { app: "Paytm", scheme: "paytmmp" },
};

export function asHeadlessPsp(v: unknown): HeadlessPsp | null {
  return typeof v === "string" && (HEADLESS_PSPS as string[]).includes(v) ? (v as HeadlessPsp) : null;
}

// UPI handles each app issues. @ybl / @ibl / @axl are PhonePe's; @paytm and the @pt* bank
// handles are Paytm's.
const HANDLES: Record<string, HeadlessPsp> = {
  ybl: "PHONEPE", ibl: "PHONEPE", axl: "PHONEPE",
  paytm: "PAYTM", ptyes: "PAYTM", ptaxis: "PAYTM", pthdfc: "PAYTM", ptsbi: "PAYTM",
};

/** The PSP a UPI ID's handle belongs to (`name@ybl` → PhonePe), or null for any other handle. */
export function pspForVpa(vpa: string | null | undefined): HeadlessPsp | null {
  const at = (vpa ?? "").trim().toLowerCase().lastIndexOf("@");
  if (at < 1) return null;
  return HANDLES[(vpa ?? "").trim().toLowerCase().slice(at + 1)] ?? null;
}

const VPA_RE = /^[a-z0-9.\-_]{1,256}@[a-z][a-z0-9]{1,63}$/i;
/** A UPI ID in the shape NPCI allows (name@handle). */
export function validVpa(vpa: string): boolean {
  return VPA_RE.test(vpa.trim());
}

/**
 * The PSP pre-selected for a customer: their handle's, when the banker has that PSP; else the
 * banker's first. The customer may still pick the other one.
 */
export function defaultPsp(customerVpa: string | null | undefined, available: HeadlessPsp[]): HeadlessPsp | null {
  const byHandle = pspForVpa(customerVpa);
  if (byHandle && available.includes(byHandle)) return byHandle;
  return available[0] ?? null;
}

/**
 * The link the Pay button fires for a PSP: the PSP's own app link when it gave one, else the
 * app's scheme with the UPI intent's query, with the plain upi:// link as the fallback.
 */
export function pspAppLink(psp: HeadlessPsp, intentQuery: string, appLinks?: Partial<Record<"paytm" | "phonepe", string>> | null): { app: string; upi: string } {
  const own = psp === "PHONEPE" ? appLinks?.phonepe : appLinks?.paytm;
  return {
    app: own || `${HEADLESS_PSP_INFO[psp].scheme}://pay?${intentQuery}`,
    upi: `upi://pay?${intentQuery}`,
  };
}

/** The URL the checkout navigates to when it is done, so the native shell can close the WebView. */
export function shellDoneUrl(orderId: string, merchantRef: string, status: string): string {
  return `katana://checkout/done?${new URLSearchParams({ id: orderId, order_id: merchantRef, status })}`;
}

/** Why a Pay tap can't start a payment, in the customer's words; null = it may. */
export function startRefusal(o: {
  headless: boolean; status: string; expired: boolean; chosen: HeadlessPsp | null; psp: HeadlessPsp; available: HeadlessPsp[];
}): { code: string; message: string } | null {
  if (!o.headless) return { code: "NOT_HEADLESS", message: "This payment is not paid from this page." };
  if (o.status !== "PENDING" && o.status !== "INITIATED") return { code: "NOT_PAYABLE", message: "This payment is already finished." };
  if (o.expired) return { code: "EXPIRED", message: "The time to pay is over. Go back and start again." };
  if (!o.available.includes(o.psp)) return { code: "PSP_UNAVAILABLE", message: `${HEADLESS_PSP_INFO[o.psp].app} can't be used for this payment.` };
  // One payment per order: once an app was asked, switching would leave a second payment
  // request open that nobody follows.
  if (o.chosen && o.chosen !== o.psp) return { code: "PSP_LOCKED", message: `This payment was started in ${HEADLESS_PSP_INFO[o.chosen].app}. Pay there, or go back and start again.` };
  return null;
}
