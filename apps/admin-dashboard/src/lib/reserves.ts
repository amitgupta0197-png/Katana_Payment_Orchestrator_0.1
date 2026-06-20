// Reserve release sweep. Releases all SCHEDULED reserve holds whose
// scheduled_at has passed, posting a balanced reserve.release journal per hold
// (RESERVE -> PAYABLE) and marking the calendar row RELEASED. Idempotent via the
// journal idempotency_key. Used by the settlement trigger and can run standalone.

import { rows } from "@/lib/pg";
import { postJournal } from "@/lib/ledger";

export async function releaseDueReserves(limit = 500): Promise<{ released: number; total_minor: string }> {
  const due = await rows<any>("ledger", `
    SELECT release_id::text, merchant_id, amount_minor::text AS amount_minor, currency
      FROM reserve_release_calendar
     WHERE status = 'SCHEDULED' AND scheduled_at <= now()
     ORDER BY scheduled_at ASC
     LIMIT ${Math.min(limit, 1000)}
  `).catch(() => []);

  let released = 0;
  let total = 0n;
  for (const c of due) {
    try {
      const j = await postJournal({
        journal_type: "reserve.release",
        narration: `Scheduled reserve release for ${c.merchant_id}`,
        currency: c.currency,
        merchant_id: c.merchant_id,
        ref: { type: "reserve_release", id: c.release_id },
        idempotency_key: `reserve.release:${c.release_id}`,
        lines: [
          { account_code: `LIABILITIES.MERCHANT_RESERVE.${c.merchant_id}`, account_type: "LIABILITY",
            side: "D", amount_minor: c.amount_minor, currency: c.currency },
          { account_code: `LIABILITIES.MERCHANT_PAYABLE.${c.merchant_id}`, account_type: "LIABILITY",
            side: "C", amount_minor: c.amount_minor, currency: c.currency },
        ],
      });
      await rows("ledger", `
        UPDATE reserve_release_calendar
           SET status='RELEASED', released_at=now(), release_journal_id=$1::uuid
         WHERE release_id=$2::uuid AND status='SCHEDULED'
      `, [j.journal_id, c.release_id]);
      released += 1;
      total += BigInt(c.amount_minor);
    } catch { /* skip this hold; others continue */ }
  }
  return { released, total_minor: total.toString() };
}
