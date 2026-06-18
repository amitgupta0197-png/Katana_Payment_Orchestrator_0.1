// GET a single KYB case + linked documents + screening hits + decision
// history. Same persona policy as /api/kyb (SUPER_ADMIN | PROVIDER own |
// MERCHANT own) — defense-in-depth: re-checks scope after the case row is
// loaded so a PROVIDER can't fetch a case for an unmapped merchant by id.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  try {
    const caseRows = await rows<any>("kybPayments", `
      SELECT id::text, tenant_id, merchant_id, status, risk_tier,
             opened_at, decided_at, COALESCE(decided_by,'') AS decided_by,
             screening_hits, doc_count
        FROM kyb_cases WHERE id = $1::uuid LIMIT 1
    `, [id]).catch(() => []);
    if (!caseRows.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    const kybCase = caseRows[0];

    // Scope check — refuse if the caller persona shouldn't see this merchant.
    if (s.persona === "MERCHANT" && kybCase.merchant_id !== s.scope_id) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.includes(kybCase.merchant_id)) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }

    const [docs, screening, decisions] = await Promise.all([
      rows<any>("kybPayments", `
        SELECT id::text, doc_type, COALESCE(uri,'') AS uri, COALESCE(sha256,'') AS sha256,
               COALESCE(verified_at::text,'') AS verified_at,
               COALESCE(verified_by,'') AS verified_by, created_at
          FROM kyb_documents WHERE case_id = $1::uuid ORDER BY created_at DESC
      `, [id]).catch(() => []),
      rows<any>("kybPayments", `
        SELECT id::text, hit_kind, COALESCE(provider,'') AS provider,
               COALESCE(score::text,'') AS score, COALESCE(payload::text,'{}') AS payload,
               created_at
          FROM kyb_screening_hits WHERE case_id = $1::uuid ORDER BY created_at DESC
      `, [id]).catch(() => []),
      rows<any>("kybPayments", `
        SELECT id::text, decision, COALESCE(actor,'') AS actor, COALESCE(notes,'') AS notes, decided_at
          FROM kyb_decisions WHERE case_id = $1::uuid ORDER BY decided_at DESC
      `, [id]).catch(() => []),
    ]);

    return NextResponse.json({ case: kybCase, docs, screening, decisions });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
