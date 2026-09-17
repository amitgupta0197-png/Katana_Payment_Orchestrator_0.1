// Provider payout reconciliation: each gateway's transfers vs Katana's payout orders for a day
// range, per merchant, for every payout gateway with a connector.
//
// It only reports. Every difference becomes an exception row (fifo_recon_items) for a person
// to look at; nothing here changes a payout or a balance. Buckets:
//
//   MATCHED              same amount, same final status, same UTR
//   MISSING_AT_PROVIDER  Katana sent it (or thinks it did); the gateway has no such transfer
//   UNKNOWN_AT_KATANA    the gateway has a transfer Katana never sent (e.g. made in its dashboard)
//   STATUS_MISMATCH      final on one side, different on the other
//   AMOUNT_MISMATCH      amounts differ
//   UTR_MISMATCH         both paid, bank references differ
//   PENDING              still in flight on both sides — not an exception yet
//   UNCHECKED            the gateway couldn't be asked about this payout this time
//
// Gateways with a list API (PayU, RazorpayX) are compared both ways. For the others (Cashfree,
// Paytm) each of Katana's payouts is looked up one by one, so UNKNOWN_AT_KATANA can't be seen
// there — their dashboards remain the place to spot transfers made outside Katana.

import { rows } from "@/lib/pg";
import { publicPayoutStatus } from "@/lib/payout-api";
import { gatewayName } from "@/lib/pg-catalog";
import { providerCreds, PAYOUT_PROVIDERS, type TransferState } from "@/lib/payout-providers";
import { istDay } from "@/lib/payout-providers/types";

export type ProviderReconBucket = "MATCHED" | "MISSING_AT_PROVIDER" | "UNKNOWN_AT_KATANA" | "STATUS_MISMATCH" | "AMOUNT_MISMATCH" | "UTR_MISMATCH" | "PENDING" | "UNCHECKED";

type Item = { merchant: string; provider: string; ref: string; order_ref: string | null; utr: string | null; expected: bigint | null; reported: bigint | null; bucket: ProviderReconBucket; detail: string };

function compare(o: any, t: TransferState, name: string): { bucket: ProviderReconBucket; detail: string; reported: bigint | null } {
  const expected = BigInt(o.amount_minor);
  const k = publicPayoutStatus(o.status);
  const reported = t.amountMinor ?? null;
  const theirs = t.final ?? null;
  if (t.amountMinor != null && t.amountMinor !== expected)
    return { reported, bucket: "AMOUNT_MISMATCH", detail: `${name} ${t.amountMinor} vs Katana ${expected}` };
  if (!theirs && k === "PROCESSING")
    return { reported, bucket: "PENDING", detail: `${name} ${t.status}` };
  if ((theirs ?? "PROCESSING") !== k && !(theirs === "REVERSED" && k === "FAILED"))
    return { reported, bucket: "STATUS_MISMATCH", detail: `${name} ${t.status} vs Katana ${o.status}` };
  if (theirs === "SUCCESS" && t.bankRef && o.utr && t.bankRef !== o.utr)
    return { reported, bucket: "UTR_MISMATCH", detail: `${name} UTR ${t.bankRef} vs Katana ${o.utr}` };
  return { reported, bucket: "MATCHED", detail: "" };
}

export async function runProviderPayoutRecon(input: { from: Date; to: Date; merchantId?: string; provider?: string; createdBy?: string }) {
  const providers = input.provider ? [input.provider] : PAYOUT_PROVIDERS;
  // (merchant, provider) pairs with provider payouts in the range (or the merchant asked for).
  const pairs = await rows<{ merchant_id: string; provider: string }>("fifo", `
    SELECT DISTINCT merchant_id, provider FROM fifo_orders
     WHERE provider = ANY($3::text[]) AND direction='PAYOUT'
       AND created_at >= $1::date - 1 AND created_at < $2::date + 2
       AND ($4::text IS NULL OR merchant_id = $4)
  `, [istDay(input.from), istDay(input.to), providers, input.merchantId ?? null]);

  const items: Item[] = [];
  const errors: Record<string, string> = {};

  for (const { merchant_id: m, provider } of pairs) {
    const name = gatewayName(provider);
    const label = `${m}/${provider}`;
    const active = await providerCreds(provider, m);
    if (!active) { errors[label] = `no ${name} payout credentials`; continue; }
    const { connector, creds } = active;

    // Katana's side: payouts created in the same IST days.
    const ours = await rows<any>("fifo", `
      SELECT order_ref, txn_ref, status, amount_minor::text, utr, provider_ref, created_at, submitted_at
        FROM fifo_orders
       WHERE merchant_id=$1 AND provider=$4 AND direction='PAYOUT'
         AND created_at >= (($2::date) AT TIME ZONE 'Asia/Kolkata')
         AND created_at <  (($3::date + 1) AT TIME ZONE 'Asia/Kolkata')
    `, [m, istDay(input.from), istDay(input.to), provider]);

    let atProvider: Map<string, TransferState & { ref: string }> | null = null;
    if (connector.list) {
      const list = await connector.list(creds, input.from, input.to);
      if (!list.ok) { errors[label] = list.error; continue; }
      atProvider = new Map(list.data.map((t) => [t.ref, t]));
    }

    for (const o of ours) {
      const ref = connector.providerRefFor(o.txn_ref);
      const base = { merchant: m, provider, ref: o.txn_ref, order_ref: o.order_ref, utr: o.utr, expected: BigInt(o.amount_minor) };
      // Never sent (held, rejected, cancelled) is not an exception.
      if (!o.submitted_at) { atProvider?.delete(ref); continue; }

      let t: TransferState | undefined;
      if (atProvider) {
        t = atProvider.get(ref);
        atProvider.delete(ref);
      } else {
        const r = await connector.status(creds, ref, { createdAt: new Date(o.created_at), providerRef: o.provider_ref, timeoutMs: 15_000 });
        if (!r.ok) { items.push({ ...base, reported: null, bucket: "UNCHECKED", detail: `${name}: ${r.error}` }); continue; }
        t = r.data.found ? r.data : undefined;
      }
      if (!t) {
        items.push({ ...base, reported: null, bucket: "MISSING_AT_PROVIDER", detail: `Katana ${o.status}; ${name} has no transfer ${ref}` });
        continue;
      }
      items.push({ ...base, ...compare(o, t, name) });
    }
    for (const t of atProvider?.values() ?? []) {
      items.push({ merchant: m, provider, ref: connector.txnRefFrom(t.ref), order_ref: null, utr: t.bankRef ?? null, expected: null, reported: t.amountMinor ?? null,
        bucket: "UNKNOWN_AT_KATANA", detail: `${name} ${t.status} transfer ${t.ref || "(no reference)"} (${t.providerRef ?? "no id"}) not sent by Katana` });
    }
  }

  const summary: Record<string, number> = {};
  for (const it of items) summary[it.bucket] = (summary[it.bucket] ?? 0) + 1;
  const matched = (summary.MATCHED ?? 0) + (summary.PENDING ?? 0);
  const source = input.provider ? `${input.provider}_PAYOUT` : "PROVIDER_PAYOUT";
  const run = (await rows<{ id: string }>("fifo", `
    INSERT INTO fifo_recon_runs (source, total_items, matched, mismatched, summary, created_by)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id::text
  `, [source, items.length, matched, items.length - matched,
      JSON.stringify({ ...summary, range: `${istDay(input.from)}..${istDay(input.to)}`, errors }), input.createdBy ?? null]))[0];
  for (const it of items) {
    await rows("fifo", `
      INSERT INTO fifo_recon_items (run_id, order_ref, txn_ref, utr, direction, expected_minor, reported_minor, bucket, detail, resolved)
      VALUES ($1::uuid,$2,$3,$4,'PAYOUT',$5,$6,$7,$8,$9)
    `, [run.id, it.order_ref, it.ref, it.utr, it.expected?.toString() ?? null, it.reported?.toString() ?? null,
        it.bucket, `${it.merchant} (${gatewayName(it.provider)}): ${it.detail}`.replace(/: $/, ""), it.bucket === "MATCHED"]).catch(() => {});
  }
  return { run_id: run.id, total: items.length, matched, mismatched: items.length - matched, summary, errors };
}
