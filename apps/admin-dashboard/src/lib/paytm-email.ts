// Paytm "Payment Received" email parser.
//
// Paytm for Business emails each incoming UPI credit from no-reply@paytm.com with a
// consistent template. The email carries amount + payer VPA (masked) + full Order ID +
// time, but NOT the RRN/UTR (that lives only in Paytm's system, fetched later by Order
// ID via the Transaction Status API). The Order ID is a strong unique key for
// reconciliation and the input to the RRN lookup.
//
// Two Order ID shapes are seen, both handled by the same token regex:
//   - static-QR txn:  T2607032117293874938735
//   - gateway order:  PTMf854870841fe4a949156f55d0080b0d6

export interface ParsedPaytmEmail {
  amount: number;
  orderRef: string;      // Paytm Order ID (unique key; RRN-lookup input)
  payerVpa: string | null;   // masked, e.g. 6305XX@ybl
  payeeName: string | null;  // "In Account of" value, e.g. PRIME MART 2
  eventTime: string | null;  // e.g. "Jul 3, 2026, 9:17 PM"
  txnCount: string | null;   // Paytm's "Transaction Count #307"
}

// Collapse an HTML or text email body to a single normalised line of readable text.
function normalise(raw: string): string {
  return raw
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#8377;|&rupee;/gi, "₹")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

const AMOUNT = /(?:₹|Rs\.?|INR)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;
const SUBJECT_AMOUNT = /Rs\.?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*paid/i;
const ORDER_ID = /Order\s*ID:?\s*([A-Za-z0-9]{8,60})/i;
const VPA = /([A-Za-z0-9._-]{2,}@[A-Za-z]{2,})/;
const PAYEE = /In\s*Account\s*of\s+(.+?)\s+(?:[A-Z][a-z]{2}\s+\d{1,2},|Order\s*ID)/i;
const EVENT_TIME = /([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4},\s*\d{1,2}:\d{2}\s*[AP]M)/g;
const TXN_COUNT = /Transaction\s*Count\s*#?\s*(\d+)/i;

function toAmount(s: string | undefined): number | null {
  if (!s) return null;
  const v = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Parse a Paytm payment-received email. Returns null if it isn't one / lacks the
// essentials (amount + Order ID). `from` and `subject` are optional but improve the
// guard and amount fallback.
export function parsePaytmEmail(input: { from?: string; subject?: string; text: string }): ParsedPaytmEmail | null {
  const from = (input.from ?? "").toLowerCase();
  const body = normalise(input.text ?? "");
  const subject = input.subject ?? "";

  // Guard: must look like a Paytm payment-received mail.
  const fromPaytm = from.includes("paytm") || /no-?reply@paytm/i.test(body);
  const isReceipt = /Payment\s*Received/i.test(body) || /paid\s*at/i.test(subject);
  if (!fromPaytm || !isReceipt) return null;

  const amount = toAmount(AMOUNT.exec(body)?.[1]) ?? toAmount(SUBJECT_AMOUNT.exec(subject)?.[1]);
  const orderRef = ORDER_ID.exec(body)?.[1] ?? null;
  if (amount == null || !orderRef) return null;

  const payerVpa = VPA.exec(body)?.[1] ?? null;
  const payeeName = PAYEE.exec(body)?.[1]?.trim() ?? null;
  // The transaction time is the LAST date-time in the body (just before Order ID),
  // not any header/footer timestamp.
  const times = body.match(EVENT_TIME);
  const eventTime = times && times.length ? times[times.length - 1] : null;
  const txnCount = TXN_COUNT.exec(body)?.[1] ?? null;

  return { amount, orderRef, payerVpa, payeeName, eventTime, txnCount };
}
