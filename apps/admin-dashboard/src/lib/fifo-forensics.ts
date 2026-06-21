// Forensic Evidence Pack generator (PayTech BRD §25, FR-010, §30 Forensic Report).
//
// Assembles a single tamper-evident bundle for an order from data already held
// across the FIFO + ledger stores: order summary, status timeline, queue/operator
// assignment, customer + device/IP, proof files with their evidence hashes, ledger
// entries, settlement reference and any fraud alerts. A SHA-256 report_hash is
// computed over the canonical pack and recorded so the pack itself is auditable.

import { createHash } from "crypto";
import { rows } from "@/lib/pg";

export interface EvidencePack {
  pack_version: string;
  generated_at: string;
  generated_by: string | null;
  order: Record<string, unknown> | null;
  queue_assignment: Record<string, unknown> | null;
  operator: Record<string, unknown> | null;
  timeline: Record<string, unknown>[];
  proofs: Record<string, unknown>[];
  ledger_entries: Record<string, unknown>[];
  fraud_alerts: Record<string, unknown>[];
  device: Record<string, unknown> | null;
  settlement_reference: { utr: string | null; tx_hash: string | null };
  section_count: number;
  report_hash?: string;
}

// Deterministic-ish stable stringify (sorted keys) so the same pack hashes the same.
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>).sort().reduce((acc, k) => {
        acc[k] = (v as Record<string, unknown>)[k]; return acc;
      }, {} as Record<string, unknown>);
    }
    return v;
  });
}

export async function buildEvidencePack(orderIdOrRef: string, generatedBy?: string | null): Promise<EvidencePack | null> {
  const order = (await rows<any>("fifo", `
    SELECT id::text, order_ref, merchant_id, direction, amount_minor::text, currency, settlement_mode,
           customer_name, customer_phone, customer_email, purpose, status, risk_score, risk_decision,
           txn_ref, utr, tx_hash, beneficiary_id::text, device_ip, device_fingerprint,
           created_at, validated_at, queued_at, completed_at
      FROM fifo_orders WHERE order_ref = $1 OR id::text = $1 LIMIT 1
  `, [orderIdOrRef]))[0];
  if (!order) return null;

  const queue = (await rows<any>("fifo", `
    SELECT id::text AS queue_id, priority, status, enqueued_at, assigned_to::text,
           assigned_at, accepted_at, sla_due_at, reassign_count
      FROM fifo_queue WHERE order_id = $1::uuid
  `, [order.id]))[0] ?? null;

  const operator = queue?.assigned_to
    ? (await rows<any>("fifo", `SELECT id::text, email, name, status FROM fifo_operators WHERE id=$1::uuid`, [queue.assigned_to]))[0] ?? null
    : null;

  const timeline = await rows<any>("fifo", `
    SELECT from_status, to_status, actor, actor_kind, reason, payload, at
      FROM fifo_order_events WHERE order_id = $1::uuid ORDER BY at ASC
  `, [order.id]);

  const proofs = await rows<any>("fifo", `
    SELECT kind, filename, content_type, size_bytes, sha256, storage_ref, uploaded_by, uploaded_at
      FROM fifo_order_proofs WHERE order_id = $1::uuid ORDER BY uploaded_at ASC
  `, [order.id]);

  const fraud_alerts = await rows<any>("fifo", `
    SELECT alert_type, severity, detail, status, created_at
      FROM fifo_fraud_alerts WHERE order_id = $1::uuid ORDER BY created_at ASC
  `, [order.id]);

  // Ledger linkage — completion posts with ref {type:'payment', id: txn_ref}.
  let ledger_entries: any[] = [];
  if (order.txn_ref) {
    ledger_entries = await rows<any>("ledger", `
      SELECT je.id::text AS journal_id, je.journal_type, je.narration, je.currency,
             je.total_debit_minor::text, je.total_credit_minor::text, je.entry_hash, je.created_at,
             a.code AS account_code, ll.side, ll.amount_minor::text AS line_amount_minor
        FROM journal_entries je
        JOIN ledger_lines ll ON ll.journal_id = je.id
        JOIN accounts a ON a.id = ll.account_id
       WHERE je.ref_type = 'payment' AND je.ref_id = $1
       ORDER BY je.created_at ASC, a.code ASC
    `, [order.txn_ref]).catch(() => []);
  }

  const pack: EvidencePack = {
    pack_version: "1.0",
    generated_at: new Date().toISOString(),
    generated_by: generatedBy ?? null,
    order,
    queue_assignment: queue,
    operator,
    timeline,
    proofs,
    ledger_entries,
    fraud_alerts,
    device: { ip: order.device_ip ?? null, fingerprint: order.device_fingerprint ?? null },
    settlement_reference: { utr: order.utr ?? null, tx_hash: order.tx_hash ?? null },
    section_count: 0,
  };
  pack.section_count = [pack.order, pack.queue_assignment, pack.operator, pack.timeline, pack.proofs,
    pack.ledger_entries, pack.fraud_alerts, pack.device, pack.settlement_reference].filter(Boolean).length;

  // report_hash over the pack body (excluding the hash + the volatile generated_at).
  const { report_hash: _omit, generated_at: _ts, ...hashable } = pack as EvidencePack & { report_hash?: string };
  pack.report_hash = createHash("sha256").update(stable(hashable)).digest("hex");

  await rows("fifo", `
    INSERT INTO fifo_evidence_packs (order_id, order_ref, report_hash, section_count, generated_by)
    VALUES ($1::uuid, $2, $3, $4, $5)
  `, [order.id, order.order_ref, pack.report_hash, pack.section_count, generatedBy ?? null]).catch(() => {});

  return pack;
}
