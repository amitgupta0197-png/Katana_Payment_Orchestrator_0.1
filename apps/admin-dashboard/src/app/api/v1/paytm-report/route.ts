// POST /api/v1/paytm-report — ingest a Paytm transaction/settlement report (CSV).
//
// The report carries the per-transaction RRN for every row (which the real-time email
// lacks), keyed by the same Order ID. For each successful row we BACKFILL the RRN onto
// the alert the email/notification already created (matched by order_ref) and propagate
// it to the matched order — no duplicate rows. Rows with no existing alert (never
// emailed) are ingested fresh via the reconciler.
//
// Body: JSON { csv, merchant_id? } or a raw CSV body. Public route (sandbox header),
// whitelisted in middleware.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { ingestTxnAlert } from "@/lib/txn-reconcile";
import { parsePaytmReport } from "@/lib/paytm-report";

export const dynamic = "force-dynamic";

const MAX_ROWS = 5000;

export async function POST(req: Request) {
  if (req.headers.get("x-sandbox") !== "1") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const bodyText = await req.text();
  let csv = bodyText;
  let merchantId: string | undefined;
  // Accept JSON { csv, merchant_id } or a raw CSV body.
  if (bodyText.trimStart().startsWith("{")) {
    try {
      const j = JSON.parse(bodyText);
      csv = String(j.csv ?? "");
      merchantId = j.merchant_id ? String(j.merchant_id) : undefined;
    } catch { /* fall through: treat as raw CSV */ }
  }

  const { rows: parsed, total, skipped } = parsePaytmReport(csv);
  if (!parsed.length) return NextResponse.json({ ok: true, total, parsed: 0, skipped, detail: "no usable rows" });
  if (parsed.length > MAX_ROWS) return NextResponse.json({ error: `too many rows (${parsed.length} > ${MAX_ROWS})` }, { status: 413 });

  let backfilled = 0, inserted = 0, orders = 0, failed = 0;

  for (const r of parsed) {
    try {
      // 1) Backfill the RRN onto an existing alert for this Order ID (utr not yet set).
      const hit = await rows<{ id: string; matched_order_id: string | null }>("vendorGateway", `
        UPDATE vendor_txn_alerts
           SET utr = COALESCE(NULLIF(utr,''), $2),
               payer_vpa = COALESCE(NULLIF(payer_vpa,''), $3)
         WHERE order_ref = $1 AND (utr IS NULL OR utr = '')
        RETURNING id::text, matched_order_id
      `, [r.orderRef, r.rrn, r.payerVpa]);

      if (hit.length) {
        backfilled += hit.length;
        // 2) Propagate the RRN to any matched order.
        for (const h of hit) {
          if (h.matched_order_id) {
            await rows("fifo", `UPDATE fifo_orders SET utr = COALESCE(utr,$2) WHERE id = $1::uuid`,
              [h.matched_order_id, r.rrn]).then(() => { orders++; }).catch(() => {});
          }
        }
      } else {
        // 3) No existing alert (never emailed) → ingest fresh, with the RRN, via the reconciler.
        await ingestTxnAlert({
          source: "EMAIL",
          merchant_id: merchantId,
          bank: "PAYTM",
          sender: "paytm-report",
          direction: "CREDIT",
          amount: r.amount,
          utr: r.rrn,
          order_ref: r.orderRef,
          payer_vpa: r.payerVpa ?? undefined,
          event_time: r.txnDate ?? undefined,
          nonce: `paytm-report:${r.orderRef}`,
          parser_version: "paytm-report-1.0",
          raw: `PAYTM report amt=${r.amount} order=${r.orderRef} rrn=${r.rrn} payer=${r.payerVpa ?? "?"}`,
        });
        inserted++;
      }
    } catch { failed++; }
  }

  return NextResponse.json({ ok: true, total, parsed: parsed.length, skipped, backfilled, inserted, orders_updated: orders, failed });
}
