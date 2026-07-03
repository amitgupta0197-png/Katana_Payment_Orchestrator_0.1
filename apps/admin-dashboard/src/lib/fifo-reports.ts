// FIFO reports (Katana BRD §30). Each report returns a {columns, rows} shape the
// UI renders as a table and exports to CSV. Fee/reserve mirror the settlement
// posting in settlePayinToLedger (MDR 1.95%, rolling reserve 5%).

import { rows } from "@/lib/pg";

const MDR_BPS = 195, RESERVE_BPS = 500;
export type ReportType = "merchant" | "operator" | "settlement" | "risk" | "forensic";
export const REPORT_TYPES: ReportType[] = ["merchant", "operator", "settlement", "risk", "forensic"];

export interface Report { columns: string[]; rows: Record<string, unknown>[] }

export async function buildReport(type: ReportType): Promise<Report> {
  if (type === "merchant") {
    const r = await rows<any>("fifo", `
      SELECT order_ref, merchant_id, direction, amount_minor::text, currency, status,
             customer_name, utr, settlement_mode, created_at, completed_at
        FROM fifo_orders ORDER BY created_at DESC LIMIT 500
    `);
    return {
      columns: ["order_ref", "merchant_id", "direction", "amount", "currency", "status", "fee", "net", "utr", "created_at"],
      rows: r.map((o) => {
        const amt = Number(o.amount_minor);
        const fee = o.direction === "PAYIN" ? Math.round((amt * MDR_BPS) / 10000) : 0;
        const reserve = o.direction === "PAYIN" ? Math.round((amt * RESERVE_BPS) / 10000) : 0;
        return { order_ref: o.order_ref, merchant_id: o.merchant_id, direction: o.direction,
          amount: amt / 100, currency: o.currency, status: o.status,
          fee: fee / 100, net: (amt - fee - reserve) / 100, utr: o.utr ?? "", created_at: o.created_at };
      }),
    };
  }

  if (type === "operator") {
    const r = await rows<any>("fifo", `
      SELECT op.email, COALESCE(op.name, op.email) AS name, op.status,
             COUNT(q.id) FILTER (WHERE q.assigned_to = op.id)::int AS assigned,
             COUNT(q.id) FILTER (WHERE q.assigned_to = op.id AND q.accepted_at IS NOT NULL)::int AS accepted,
             COUNT(q.id) FILTER (WHERE q.assigned_to = op.id AND q.status = 'DONE')::int AS completed,
             COUNT(q.id) FILTER (WHERE q.assigned_to = op.id AND q.status = 'CANCELLED')::int AS rejected,
             COUNT(q.id) FILTER (WHERE q.assigned_to = op.id AND q.reassign_count > 0)::int AS sla_breaches,
             COUNT(q.id) FILTER (WHERE q.assigned_to = op.id AND q.accepted_at IS NOT NULL
                                  AND EXTRACT(HOUR FROM q.accepted_at) < 6)::int AS after_hours,
             COUNT(q.id) FILTER (WHERE q.assigned_to = op.id AND q.status='DONE'
                                  AND NOT EXISTS (SELECT 1 FROM fifo_order_proofs p WHERE p.order_id = q.order_id))::int AS proof_missing
        FROM fifo_operators op LEFT JOIN fifo_queue q ON q.assigned_to = op.id
       GROUP BY op.id, op.email, op.name, op.status ORDER BY completed DESC
    `);
    const rowsOut = r.map((o) => {
      const handled = (o.completed ?? 0) + (o.rejected ?? 0);
      return { ...o, rejection_ratio: handled ? Math.round((o.rejected / handled) * 100) + "%" : "—" };
    });
    return { columns: ["email", "name", "status", "assigned", "accepted", "completed", "rejected", "rejection_ratio", "sla_breaches", "after_hours", "proof_missing"], rows: rowsOut };
  }

  if (type === "settlement") {
    const r = await rows<any>("fifo", `
      SELECT merchant_id, COUNT(*)::int AS txns, COALESCE(SUM(amount_minor),0)::text AS gross
        FROM fifo_orders WHERE direction='PAYIN' AND status IN ('COMPLETED','SETTLED')
       GROUP BY merchant_id ORDER BY gross DESC
    `);
    return {
      columns: ["merchant_id", "txns", "gross", "fee", "reserve", "net_payable"],
      rows: r.map((m) => {
        const gross = Number(m.gross);
        const fee = Math.round((gross * MDR_BPS) / 10000);
        const reserve = Math.round((gross * RESERVE_BPS) / 10000);
        return { merchant_id: m.merchant_id, txns: m.txns, gross: gross / 100, fee: fee / 100, reserve: reserve / 100, net_payable: (gross - fee - reserve) / 100 };
      }),
    };
  }

  if (type === "risk") {
    const r = await rows<any>("fifo", `
      SELECT alert_type, severity, order_ref, merchant_id, detail, status, created_at
        FROM fifo_fraud_alerts ORDER BY created_at DESC LIMIT 500
    `);
    return { columns: ["alert_type", "severity", "order_ref", "merchant_id", "detail", "status", "created_at"], rows: r };
  }

  // forensic
  const r = await rows<any>("fifo", `
    SELECT order_ref, report_hash, section_count, generated_by, generated_at
      FROM fifo_evidence_packs ORDER BY generated_at DESC LIMIT 500
  `);
  return { columns: ["order_ref", "report_hash", "section_count", "generated_by", "generated_at"], rows: r };
}
