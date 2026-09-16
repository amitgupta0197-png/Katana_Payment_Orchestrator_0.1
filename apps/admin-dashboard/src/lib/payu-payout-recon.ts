// PayU payout reconciliation: PayU's transfer list vs Katana's payout orders for a day range.
//
// It only reports. Every difference becomes an exception row (fifo_recon_items) for a person
// to look at; nothing here changes a payout or a balance. Buckets:
//
//   MATCHED              same amount, same final status, same UTR
//   MISSING_AT_PROVIDER  Katana sent it (or thinks it did); PayU has no such transfer
//   UNKNOWN_AT_KATANA    PayU has a transfer Katana never sent (e.g. made in PayU's dashboard)
//   STATUS_MISMATCH      final on one side, different on the other
//   AMOUNT_MISMATCH      amounts differ
//   UTR_MISMATCH         both paid, bank references differ
//   PENDING              still in flight on both sides — not an exception yet

import { rows } from "@/lib/pg";
import { getPayuPayoutCreds, payuListTransfers } from "@/lib/payu-payout";
import { publicPayoutStatus } from "@/lib/payout-api";

export type PayuReconBucket = "MATCHED" | "MISSING_AT_PROVIDER" | "UNKNOWN_AT_KATANA" | "STATUS_MISMATCH" | "AMOUNT_MISMATCH" | "UTR_MISMATCH" | "PENDING";

// PayU's txnStatus in the merchant-facing vocabulary; anything unlisted is still in flight.
function payuFinal(s?: string): "SUCCESS" | "FAILED" | "REVERSED" | null {
  if (s === "SUCCESS") return "SUCCESS";
  if (s === "FAILED") return "FAILED";
  if (s === "REVERSED") return "REVERSED";
  return null;
}

export async function runPayuPayoutRecon(input: { from: Date; to: Date; merchantId?: string; createdBy?: string }) {
  // Merchants with PayU payouts in the range (or the one asked for).
  const merchants = input.merchantId ? [input.merchantId] : (await rows<{ merchant_id: string }>("fifo", `
    SELECT DISTINCT merchant_id FROM fifo_orders
     WHERE provider='PAYU' AND direction='PAYOUT'
       AND created_at >= $1::date - 1 AND created_at < $2::date + 2
  `, [input.from.toISOString().slice(0, 10), input.to.toISOString().slice(0, 10)])).map((r) => r.merchant_id);

  const items: { merchant: string; ref: string; order_ref: string | null; utr: string | null; expected: bigint | null; reported: bigint | null; bucket: PayuReconBucket; detail: string }[] = [];
  const errors: Record<string, string> = {};

  for (const m of merchants) {
    const creds = await getPayuPayoutCreds(m);
    if (!creds) { errors[m] = "no PayU payout credentials"; continue; }
    const list = await payuListTransfers(creds, input.from, input.to);
    if (!list.ok) { errors[m] = list.error; continue; }
    const atPayu = new Map(list.data.map((t) => [t.merchantRefId, t]));

    // Katana's side: payouts created in the same IST days (one day of slack either side on
    // the query, then filtered by what PayU could have listed).
    const ours = await rows<any>("fifo", `
      SELECT order_ref, txn_ref, status, amount_minor::text, utr, created_at, submitted_at
        FROM fifo_orders
       WHERE merchant_id=$1 AND provider='PAYU' AND direction='PAYOUT'
         AND created_at >= (($2::date) AT TIME ZONE 'Asia/Kolkata')
         AND created_at <  (($3::date + 1) AT TIME ZONE 'Asia/Kolkata')
    `, [m, istDay(input.from), istDay(input.to)]);

    for (const o of ours) {
      const t = atPayu.get(o.txn_ref);
      atPayu.delete(o.txn_ref);
      const expected = BigInt(o.amount_minor);
      const k = publicPayoutStatus(o.status);
      const base = { merchant: m, ref: o.txn_ref, order_ref: o.order_ref, utr: o.utr, expected };
      if (!t) {
        // Never sent (held, rejected, cancelled) is not an exception.
        if (!o.submitted_at) continue;
        items.push({ ...base, reported: null, bucket: "MISSING_AT_PROVIDER", detail: `Katana ${o.status}; PayU has no transfer ${o.txn_ref}` });
        continue;
      }
      const theirs = payuFinal(t.status);
      if (t.amountMinor != null && t.amountMinor !== expected) {
        items.push({ ...base, reported: t.amountMinor, bucket: "AMOUNT_MISMATCH", detail: `PayU ${t.amountMinor} vs Katana ${expected}` });
      } else if (!theirs && k === "PROCESSING") {
        items.push({ ...base, reported: t.amountMinor ?? null, bucket: "PENDING", detail: `PayU ${t.status}` });
      } else if ((theirs ?? "PROCESSING") !== k && !(theirs === "REVERSED" && k === "FAILED")) {
        items.push({ ...base, reported: t.amountMinor ?? null, bucket: "STATUS_MISMATCH", detail: `PayU ${t.status} vs Katana ${o.status}` });
      } else if (theirs === "SUCCESS" && t.bankRef && o.utr && t.bankRef !== o.utr) {
        items.push({ ...base, reported: t.amountMinor ?? null, bucket: "UTR_MISMATCH", detail: `PayU UTR ${t.bankRef} vs Katana ${o.utr}` });
      } else {
        items.push({ ...base, reported: t.amountMinor ?? null, bucket: "MATCHED", detail: "" });
      }
    }
    for (const t of atPayu.values()) {
      items.push({ merchant: m, ref: t.merchantRefId, order_ref: null, utr: t.bankRef ?? null, expected: null, reported: t.amountMinor ?? null,
        bucket: "UNKNOWN_AT_KATANA", detail: `PayU ${t.status} transfer ${t.merchantRefId} (${t.payuRef ?? "no ref"}) not sent by Katana` });
    }
  }

  const summary: Record<string, number> = {};
  for (const it of items) summary[it.bucket] = (summary[it.bucket] ?? 0) + 1;
  const matched = (summary.MATCHED ?? 0) + (summary.PENDING ?? 0);
  const run = (await rows<{ id: string }>("fifo", `
    INSERT INTO fifo_recon_runs (source, total_items, matched, mismatched, summary, created_by)
    VALUES ('PAYU_PAYOUT',$1,$2,$3,$4::jsonb,$5) RETURNING id::text
  `, [items.length, matched, items.length - matched,
      JSON.stringify({ ...summary, range: `${istDay(input.from)}..${istDay(input.to)}`, errors }), input.createdBy ?? null]))[0];
  for (const it of items) {
    await rows("fifo", `
      INSERT INTO fifo_recon_items (run_id, order_ref, txn_ref, utr, direction, expected_minor, reported_minor, bucket, detail, resolved)
      VALUES ($1::uuid,$2,$3,$4,'PAYOUT',$5,$6,$7,$8,$9)
    `, [run.id, it.order_ref, it.ref, it.utr, it.expected?.toString() ?? null, it.reported?.toString() ?? null,
        it.bucket, `${it.merchant}: ${it.detail}`.replace(/: $/, ""), it.bucket === "MATCHED"]).catch(() => {});
  }
  return { run_id: run.id, total: items.length, matched, mismatched: items.length - matched, summary, errors };
}

function istDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d); // YYYY-MM-DD
}
