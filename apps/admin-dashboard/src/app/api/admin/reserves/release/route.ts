// POST /api/admin/reserves/release — release a scheduled reserve hold.
// Body: { release_id }
// Posts a balanced reserve.release journal and marks the calendar row RELEASED.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { postJournal } from "@/lib/ledger";
import { wormAppend } from "@/lib/worm";

export const dynamic = "force-dynamic";

const schema = z.object({ release_id: z.string().uuid() });

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const r = await rows<any>("ledger", `
      SELECT release_id::text, merchant_id, amount_minor::text, currency, status
        FROM reserve_release_calendar WHERE release_id=$1::uuid
    `, [body.release_id]);
    if (!r.length) return NextResponse.json({ error: "release not found" }, { status: 404 });
    const cal = r[0];
    if (cal.status !== "SCHEDULED")
      return NextResponse.json({ error: `cannot release: status=${cal.status}` }, { status: 409 });

    const j = await postJournal({
      journal_type: "reserve.release",
      narration: `Reserve release for ${cal.merchant_id}`,
      currency: cal.currency,
      merchant_id: cal.merchant_id,
      ref: { type: "reserve_release", id: body.release_id },
      idempotency_key: `reserve.release:${body.release_id}`,
      lines: [
        { account_code: `LIABILITIES.MERCHANT_RESERVE.${cal.merchant_id}`, account_type: "LIABILITY",
          side: "D", amount_minor: cal.amount_minor, currency: cal.currency },
        { account_code: `LIABILITIES.MERCHANT_PAYABLE.${cal.merchant_id}`, account_type: "LIABILITY",
          side: "C", amount_minor: cal.amount_minor, currency: cal.currency },
      ],
    });

    await rows("ledger", `
      UPDATE reserve_release_calendar
         SET status='RELEASED', released_at=now(), release_journal_id=$1::uuid
       WHERE release_id=$2::uuid
    `, [j.journal_id, body.release_id]);

    await wormAppend({
      actorId: s.user_id, actorEmail: s.email,
      action: "reserve.release",
      resourceType: "reserve_release", resourceId: body.release_id,
      before: { status: cal.status }, after: { status: "RELEASED", journal_id: j.journal_id },
    }).catch(() => null);

    return NextResponse.json({ ok: true, journal_id: j.journal_id, amount_minor: cal.amount_minor });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
