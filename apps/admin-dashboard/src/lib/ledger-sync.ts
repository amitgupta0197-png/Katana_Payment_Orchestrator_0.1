// Ledger sync: puts the live money that moves outside the Settlement Engine on the ledger, so the
// ledger's balances are the truth the engine settles from (lib/settlement-engine for the accounts).
//
//   paid pay-ins       vendor_payin_orders, live, SUCCESS        D HELD_BY_BANKER / C MERCHANT_PAYABLE
//   chargeback postings payin_chargeback_postings, live          debit: D PAYABLE / C HELD; reversal: mirror
//   settlements raised  provider_branch_settlements with no      verified: D PAYABLE / C HELD;
//   by hand             instruction                              reversed afterwards: mirror
//
// Every post has an idempotency key (payin:<id>, cb:<id>, manualsettle:<id>[:reversed]); a source
// row is stamped (or a cursor moved) only after its journal is on the ledger, so a run that dies
// half-way is simply run again. Test orders never reach the ledger. Each call takes a bounded batch:
// the cron runs it again until there is nothing left (a first run backfills history this way).

import { rows } from "@/lib/pg";
import { postJournal } from "@/lib/ledger";
import { chargebackLines, collectedLines, manualSettledLines, paiseOf, reversed } from "@/lib/settlement-engine";

export interface SyncResult { payins: number; chargebacks: number; manual: number; manual_reversed: number; errors: string[] }

const BATCH = 500;

/** A banker's merchant_code from whatever key a row carries (its code or its merchants.id). */
async function bankerCodes(keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!keys.length) return out;
  const r = await rows<{ id: string; merchant_code: string }>("merchant",
    `SELECT id::text, merchant_code FROM merchants WHERE merchant_code = ANY($1::text[]) OR id::text = ANY($1::text[])`, [keys]);
  for (const m of r) { out.set(m.id, m.merchant_code); out.set(m.merchant_code, m.merchant_code); }
  return out;
}

async function syncPayins(res: SyncResult): Promise<void> {
  const todo = await rows<{ id: string; merchant_id: string; amount: string; currency_code: string | null; paid_at: string }>("vendorGateway", `
    SELECT o.id::text, o.merchant_id, o.amount::text, o.currency_code,
           COALESCE((SELECT min(h.changed_at) FROM vendor_payin_status_history h
                      WHERE h.order_id = o.id AND h.to_status IN ('SUCCESS','SUCCEEDED')), o.updated_at, o.created_at) AS paid_at
      FROM vendor_payin_orders o
     WHERE o.ledger_posted_at IS NULL AND o.livemode AND o.status IN ('SUCCESS','SUCCEEDED')
       AND o.vendor = 'KATANA' AND o.merchant_id IS NOT NULL AND o.amount > 0
     ORDER BY o.created_at
     LIMIT ${BATCH}
  `);
  const posted: string[] = [];
  for (const o of todo) {
    try {
      await postJournal({
        journal_type: "payin.collected", narration: `pay-in ${o.id}`, currency: "INR",
        ref: { type: "payin", id: o.id }, merchant_id: o.merchant_id, idempotency_key: `payin:${o.id}`,
        value_at: o.paid_at, lines: collectedLines(o.merchant_id, paiseOf(o.amount)),
      });
      posted.push(o.id);
    } catch (e) { res.errors.push(`payin ${o.id}: ${(e as Error).message}`); }
  }
  if (posted.length)
    await rows("vendorGateway", `UPDATE vendor_payin_orders SET ledger_posted_at = now() WHERE id = ANY($1::uuid[]) AND ledger_posted_at IS NULL`, [posted]);
  res.payins = posted.length;
}

async function syncChargebacks(res: SyncResult): Promise<void> {
  const cur = (await rows<{ last_id: string }>("ledger", `SELECT last_id::text FROM ledger_sync_cursors WHERE name = 'chargeback_postings'`))[0];
  const after = cur ? Number(cur.last_id) : 0;
  const todo = await rows<{ id: string; merchant_id: string; kind: string; amount: string; created_at: string; livemode: boolean }>("vendorGateway", `
    SELECT id::text, merchant_id, kind, amount::text, created_at, livemode
      FROM payin_chargeback_postings WHERE id > $1 ORDER BY id LIMIT ${BATCH}
  `, [after]);
  let last = after;
  for (const p of todo) {
    if (p.livemode) {
      try {
        const lines = chargebackLines(p.merchant_id, paiseOf(p.amount));
        await postJournal({
          journal_type: p.kind === "CHARGEBACK_DEBIT" ? "chargeback.debit" : "chargeback.reversal",
          narration: `${p.kind.toLowerCase()} ${p.id}`, currency: "INR", ref: { type: "chargeback_posting", id: p.id },
          merchant_id: p.merchant_id, idempotency_key: `cb:${p.id}`, value_at: p.created_at,
          lines: p.kind === "CHARGEBACK_DEBIT" ? lines : reversed(lines),
        });
        res.chargebacks += 1;
      } catch (e) { res.errors.push(`chargeback posting ${p.id}: ${(e as Error).message}`); break; }   // keep order: stop here
    }
    last = Number(p.id);
  }
  if (last > after)
    await rows("ledger", `
      INSERT INTO ledger_sync_cursors (name, last_id, updated_at) VALUES ('chargeback_postings', $1, now())
      ON CONFLICT (name) DO UPDATE SET last_id = EXCLUDED.last_id, updated_at = now()`, [last]);
}

async function syncManualSettlements(res: SyncResult): Promise<void> {
  const todo = await rows<{ id: string; merchant_key: string; amount: string; status: string; posted: boolean; at: string }>("provider", `
    SELECT id::text, merchant_key, COALESCE(paid_amount, amount)::text AS amount, status, ledger_posted_at IS NOT NULL AS posted,
           COALESCE(verified_at, confirmed_at, updated_at) AS at
      FROM provider_branch_settlements
     WHERE instruction_id IS NULL
       AND ((status IN ('VERIFIED','RECONCILED') AND ledger_posted_at IS NULL)
         OR (status = 'REVERSED' AND ledger_posted_at IS NOT NULL AND ledger_reversed_at IS NULL))
     ORDER BY created_at LIMIT ${BATCH}
  `);
  const codes = await bankerCodes([...new Set(todo.map((t) => t.merchant_key))]);
  for (const s of todo) {
    const banker = codes.get(s.merchant_key);
    if (!banker) { res.errors.push(`settlement ${s.id}: no banker ${s.merchant_key}`); continue; }
    try {
      const lines = manualSettledLines(banker, paiseOf(s.amount));
      if (!s.posted) {
        await postJournal({
          journal_type: "settlement.manual", narration: `settlement ${s.id} (raised by hand)`, currency: "INR",
          ref: { type: "branch_settlement", id: s.id }, merchant_id: banker, idempotency_key: `manualsettle:${s.id}`,
          value_at: s.at, lines,
        });
        await rows("provider", `UPDATE provider_branch_settlements SET ledger_posted_at = now() WHERE id = $1::uuid AND ledger_posted_at IS NULL`, [s.id]);
        res.manual += 1;
      } else {
        await postJournal({
          journal_type: "settlement.reversed", narration: `settlement ${s.id} reversed`, currency: "INR",
          ref: { type: "branch_settlement", id: s.id }, merchant_id: banker, idempotency_key: `manualsettle:${s.id}:reversed`,
          lines: reversed(lines),
        });
        await rows("provider", `UPDATE provider_branch_settlements SET ledger_reversed_at = now() WHERE id = $1::uuid AND ledger_reversed_at IS NULL`, [s.id]);
        res.manual_reversed += 1;
      }
    } catch (e) { res.errors.push(`settlement ${s.id}: ${(e as Error).message}`); }
  }
}

/** One bounded pass over every source. Safe to run again at any time. */
export async function syncLedger(): Promise<SyncResult> {
  const res: SyncResult = { payins: 0, chargebacks: 0, manual: 0, manual_reversed: 0, errors: [] };
  await syncPayins(res);
  await syncChargebacks(res);
  await syncManualSettlements(res);
  return res;
}
