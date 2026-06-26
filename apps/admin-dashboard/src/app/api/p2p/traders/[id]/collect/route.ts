// P2P collection + UTR matching. Records a payment a trader received and matches
// the UTR, enforcing the P2P risk rules:
//   - per-txn limit, daily amount limit, daily count limit
//   - duplicate-UTR detection (a UTR settles exactly one collection)
//   - wrong-amount detection (vs an expected amount, if supplied)
// Outcomes: CORRECT (SUCCESS) · WRONG_AMOUNT/limit (MANUAL_REVIEW) · DUPLICATE (FAILED).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const schema = z.object({
  amount: z.coerce.number().positive(),
  utr: z.string().min(4).max(40),
  vpa: z.string().optional(),
  expected_amount: z.coerce.number().positive().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const t = await rows<any>("p2p", `SELECT status, per_txn_max, daily_amount_max, daily_count_max FROM p2p_traders WHERE id = $1::uuid`, [id]);
    if (!t.length) return NextResponse.json({ error: "trader not found" }, { status: 404 });
    const trader = t[0];
    if (trader.status !== "ACTIVE") return NextResponse.json({ error: `trader is ${trader.status}` }, { status: 403 });

    // Duplicate-UTR — a UTR may settle exactly one collection (across all traders).
    const dup = await rows<{ id: string }>("p2p", `SELECT id::text FROM p2p_collections WHERE utr = $1 LIMIT 1`, [body.utr]);
    if (dup.length) {
      await rows("p2p", `INSERT INTO p2p_collections (trader_id, vpa, amount, utr, status, match_result) VALUES ($1::uuid,$2,$3,$4,'FAILED','DUPLICATE')`,
        [id, body.vpa ?? null, body.amount, body.utr]).catch(() => {});
      return NextResponse.json({ match_result: "DUPLICATE", status: "FAILED", error: "duplicate UTR" }, { status: 409 });
    }

    // Limits.
    if (body.amount > Number(trader.per_txn_max)) {
      const ins = await record(id, body, "MANUAL_REVIEW", "OVER_PER_TXN_LIMIT");
      return NextResponse.json({ ...ins, note: `exceeds per-txn limit ${trader.per_txn_max}` });
    }
    const today = await rows<{ gross: number; cnt: number }>("p2p", `
      SELECT COALESCE(SUM(amount)::float,0) AS gross, COUNT(*)::int AS cnt
        FROM p2p_collections WHERE trader_id = $1::uuid AND status = 'SUCCESS' AND created_at >= CURRENT_DATE
    `, [id]);
    if (Number(today[0].gross) + body.amount > Number(trader.daily_amount_max)) {
      return NextResponse.json(await record(id, body, "MANUAL_REVIEW", "OVER_DAILY_AMOUNT"));
    }
    if (Number(today[0].cnt) + 1 > Number(trader.daily_count_max)) {
      return NextResponse.json(await record(id, body, "MANUAL_REVIEW", "OVER_DAILY_COUNT"));
    }

    // Wrong-amount vs expected.
    if (body.expected_amount !== undefined && Number(body.expected_amount) !== body.amount) {
      return NextResponse.json(await record(id, body, "MANUAL_REVIEW", "WRONG_AMOUNT"));
    }

    return NextResponse.json(await record(id, body, "SUCCESS", "CORRECT"), { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

async function record(traderId: string, body: { amount: number; utr: string; vpa?: string }, status: string, match: string) {
  const r = await rows<any>("p2p", `
    INSERT INTO p2p_collections (trader_id, vpa, amount, utr, status, match_result)
    VALUES ($1::uuid, $2, $3, $4, $5, $6)
    RETURNING id::text, amount::float AS amount, utr, status, match_result
  `, [traderId, body.vpa ?? null, body.amount, body.utr, status, match]);
  return { collection: r[0], match_result: match, status };
}
