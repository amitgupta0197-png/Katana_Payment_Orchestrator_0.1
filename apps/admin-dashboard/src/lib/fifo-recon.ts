// FIFO reconciliation engine (PayTech BRD §21, AC-007). Compares completed orders
// against the immutable ledger (and, optionally, an imported gateway/bank/USDT
// report) and classifies each into a mismatch bucket. Internal ledger recon needs
// no external file and directly satisfies AC-007 ("no mismatch between ledger and
// settlement"). Manual adjustments are routed through fifo_approvals (maker-checker).

import { rows } from "@/lib/pg";

export type ReconSource = "LEDGER" | "GATEWAY" | "BANK" | "USDT";
export type Bucket =
  | "MATCHED" | "AMOUNT_MISMATCH" | "DUPLICATE_UTR" | "MISSING_CALLBACK"
  | "DELAYED_SETTLEMENT" | "FAILED_PAYOUT_DEBIT" | "UNMATCHED";

// Settlement is expected within this window after completion (BRD §21 delayed bucket).
const SETTLE_SLA_HOURS = 24;

export interface ReportRow { reference: string; amount_minor: number | string; utr?: string }

export async function runReconciliation(input: {
  source?: ReconSource; createdBy?: string; report?: ReportRow[];
}): Promise<{ run_id: string; total: number; matched: number; mismatched: number; summary: Record<string, number> }> {
  const source: ReconSource = input.source ?? "LEDGER";

  // Completed/settled orders are the reconciliation universe.
  const orders = await rows<any>("fifo", `
    SELECT id::text, order_ref, txn_ref, utr, direction, amount_minor::text, settlement_mode, status, completed_at
      FROM fifo_orders
     WHERE status IN ('COMPLETED','SETTLED','FAILED')
     ORDER BY completed_at NULLS LAST, created_at
     LIMIT 1000
  `);

  // Ledger side: journals posted for these txn refs (payin debit / payout debit).
  const refs = orders.map((o) => o.txn_ref).filter(Boolean);
  const journals = refs.length ? await rows<any>("ledger", `
    SELECT ref_id, ref_type, total_debit_minor::text AS amt
      FROM journal_entries WHERE ref_id = ANY($1::text[])
  `, [refs]).catch(() => []) : [];
  const ledgerByRef = new Map<string, bigint>();
  for (const j of journals) { try { ledgerByRef.set(j.ref_id, BigInt(j.amt)); } catch { /* skip */ } }

  // Optional external report indexed by reference / utr.
  const reportByKey = new Map<string, bigint>();
  for (const r of input.report ?? []) {
    try { const v = BigInt(String(r.amount_minor)); reportByKey.set(r.reference, v); if (r.utr) reportByKey.set(r.utr, v); } catch { /* skip */ }
  }

  // Duplicate UTR detection across the universe.
  const utrCount = new Map<string, number>();
  for (const o of orders) if (o.utr) utrCount.set(o.utr, (utrCount.get(o.utr) ?? 0) + 1);

  const now = Date.now();
  const items: { o: any; bucket: Bucket; reported: bigint | null; detail: string }[] = [];
  for (const o of orders) {
    const expected = BigInt(o.amount_minor);
    let bucket: Bucket = "MATCHED";
    let reported: bigint | null = null;
    let detail = "";

    if (o.utr && (utrCount.get(o.utr) ?? 0) > 1) {
      bucket = "DUPLICATE_UTR"; detail = `UTR ${o.utr} on ${utrCount.get(o.utr)} orders`;
    } else if (o.status === "FAILED" && o.direction === "PAYOUT") {
      bucket = "FAILED_PAYOUT_DEBIT"; detail = "payout failed after debit";
    } else if (input.report && input.report.length) {
      // Reconcile against the imported report.
      const key = o.utr && reportByKey.has(o.utr) ? o.utr : o.order_ref;
      if (!reportByKey.has(key) && !reportByKey.has(o.txn_ref)) { bucket = "UNMATCHED"; detail = "no matching row in report"; }
      else { reported = reportByKey.get(key) ?? reportByKey.get(o.txn_ref) ?? null; if (reported !== expected) { bucket = "AMOUNT_MISMATCH"; detail = `report ${reported} vs order ${expected}`; } }
    } else {
      // Internal ledger reconciliation.
      const led = ledgerByRef.get(o.txn_ref);
      if (led === undefined) {
        bucket = "MISSING_CALLBACK"; detail = "no ledger journal for completed order";
      } else {
        reported = led;
        if (led !== expected) { bucket = "AMOUNT_MISMATCH"; detail = `ledger ${led} vs order ${expected}`; }
        else if (o.status === "COMPLETED" && o.completed_at && now - new Date(o.completed_at).getTime() > SETTLE_SLA_HOURS * 3600_000) {
          bucket = "DELAYED_SETTLEMENT"; detail = `not settled within ${SETTLE_SLA_HOURS}h`;
        }
      }
    }
    items.push({ o, bucket, reported, detail });
  }

  const summary: Record<string, number> = {};
  for (const it of items) summary[it.bucket] = (summary[it.bucket] ?? 0) + 1;
  const matched = summary["MATCHED"] ?? 0;
  const mismatched = items.length - matched;

  const run = (await rows<{ id: string }>("fifo", `
    INSERT INTO fifo_recon_runs (source, total_items, matched, mismatched, summary, created_by)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id::text
  `, [source, items.length, matched, mismatched, JSON.stringify(summary), input.createdBy ?? null]))[0];

  for (const it of items) {
    await rows("fifo", `
      INSERT INTO fifo_recon_items (run_id, order_ref, txn_ref, utr, direction, expected_minor, reported_minor, bucket, detail)
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [run.id, it.o.order_ref, it.o.txn_ref, it.o.utr, it.o.direction,
        it.o.amount_minor, it.reported !== null ? it.reported.toString() : null, it.bucket, it.detail]).catch(() => {});
  }

  return { run_id: run.id, total: items.length, matched, mismatched, summary };
}
