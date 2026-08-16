// Full payment detail for a captured credit, as the capturing screen stated it.
//
// The Android agent reads the whole GPay/Paytm detail block to find the RRN and stores the
// rest in `vendor_txn_alerts.details` (migration 0016). This renders it. Shared by the
// banker portal and the merchant (provider) portal so both personas read one payment the
// same way — a difference between the two screens would be a support call.

/** Field order: identity first, then money, then references. */
export const DETAIL_ORDER: Array<[string, string]> = [
  ["received_from", "Received from"],
  ["paid_at", "Paid at"],
  ["payment_method", "Payment method"],
  ["paid_via", "Paid via"],
  ["customer_paid", "Customer paid"],
  ["amount_you_get", "Amount you get"],
  ["credited", "Credited"],
  ["upi_transaction_id", "UPI transaction ID"],
  ["google_transaction_id", "Google transaction ID"],
  ["settlement", "Settlement"],
];

/**
 * The detail grid. Anything captured but not in DETAIL_ORDER still renders, after the known
 * fields, under its raw key — so a field added by a future app version surfaces here
 * instead of being silently dropped.
 */
export function CreditDetail({ details }: { details: Record<string, string> | null | undefined }) {
  const d = details ?? {};
  const known = DETAIL_ORDER.filter(([k]) => d[k]);
  const extra = Object.keys(d)
    .filter((k) => !DETAIL_ORDER.some(([kk]) => kk === k))
    .map((k) => [k, k.replace(/_/g, " ")] as [string, string]);
  const fields = [...known, ...extra];
  if (!fields.length) return null;

  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
      {fields.map(([k, label]) => (
        <div key={k} className="flex justify-between gap-3 border-b border-[color:var(--color-border)] py-1.5 last:border-0">
          <dt className="text-xs text-[color:var(--color-text-muted)]">{label}</dt>
          <dd className="text-right text-xs font-medium break-all">{d[k]}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Does this credit carry anything worth expanding? */
export function hasCreditDetail(details: Record<string, string> | null | undefined): boolean {
  return !!details && Object.keys(details).length > 0;
}
