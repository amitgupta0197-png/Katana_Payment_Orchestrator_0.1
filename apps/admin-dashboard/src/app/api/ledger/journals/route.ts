// Persona policy (PRODUCT_VISION §3.11): SUPER_ADMIN R+verify; PROVIDER/MERCHANT R scoped.
// Sprint 6 expansion: returns lines per journal when ?id is supplied or
// ?expand=lines is set. Surfaces the BRD §10 debit/credit invariant by
// including total_debit_minor / total_credit_minor on every row.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { getJournal } from "@/lib/ledger";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    const j = await getJournal(id);
    if (!j) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ journal: j });
  }

  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);
  const journalType = url.searchParams.get("type");
  const expand = url.searchParams.get("expand") === "lines";

  try {
    const params: unknown[] = ["tenant-default"];
    const where: string[] = ["tenant_id = $1"];
    if (s.persona === "MERCHANT") {
      params.push(s.scope_id);
      where.push(`(merchant_id = $${params.length} OR ref_id = $${params.length})`);
    } else if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ journals: [] });
      params.push(ids);
      where.push(`merchant_id = ANY($${params.length}::text[])`);
    }
    if (journalType) { params.push(journalType); where.push(`journal_type = $${params.length}`); }

    const journals = await rows<any>("ledger", `
      SELECT id::text, posted_at, currency, narration,
             COALESCE(ref_type,'') AS ref_type, COALESCE(ref_id,'') AS ref_id,
             COALESCE(idempotency_key,'') AS idempotency_key,
             COALESCE(journal_type,'') AS journal_type,
             COALESCE(merchant_id,'') AS merchant_id,
             total_debit_minor::text, total_credit_minor::text,
             entry_hash, prev_hash
        FROM journal_entries
       WHERE ${where.join(" AND ")}
       ORDER BY posted_at DESC LIMIT ${limit}
    `, params).catch(() => []);

    if (!expand) return NextResponse.json({ journals });

    // Fetch lines for the page in one shot.
    const ids = journals.map((j: any) => j.id);
    const lines = ids.length ? await rows<any>("ledger", `
      SELECT l.journal_id::text, l.id::text AS line_id, a.code AS account_code, a.type AS account_type,
             l.side, COALESCE(l.amount_minor::text, l.amount::text) AS amount_minor, l.currency
        FROM ledger_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.journal_id = ANY($1::uuid[])
       ORDER BY l.id
    `, [ids]).catch(() => []) : [];
    const byJournal = new Map<string, any[]>();
    for (const ln of lines) {
      const k = ln.journal_id; if (!byJournal.has(k)) byJournal.set(k, []);
      byJournal.get(k)!.push(ln);
    }
    return NextResponse.json({ journals: journals.map((j: any) => ({ ...j, lines: byJournal.get(j.id) ?? [] })) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
