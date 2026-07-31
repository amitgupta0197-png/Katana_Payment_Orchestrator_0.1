// Captured VPA credit transactions (bank/UPI credits landing on the provider's
// branches' settlement VPAs) for the provider dashboard. Sourced from
// vendor_txn_alerts (the Transaction-Intelligence raw credit store) and scoped by
// the settlement VPAs of the provider's mapped branches.
//   PROVIDER only (middleware restricts /api/provider-portal/* to PROVIDER).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

interface Alert {
  id: string; source: string; bank: string | null; amount: number; utr: string | null;
  order_ref: string | null; payer_vpa: string | null; payee_vpa: string | null; narration: string | null;
  matched_order_ref: string | null; outcome: string; match_confidence: number;
  event_time: string | null; created_at: string;
}

export async function GET() {
  const g = await gateOrResponse(["PROVIDER", "SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  try {
    const scoped = s.persona === "PROVIDER";
    const codes = await resolveProviderMerchants(s);
    if (scoped && !codes.length) return NextResponse.json({ vpas: [], totals: empty(), recent: [] });

    // Settlement VPAs of the provider's branches — the accounts these credits land on.
    const vpaRows = scoped
      ? await rows<{ vpa: string }>("merchant", `
          SELECT DISTINCT poolpay->>'settlement_vpa' AS vpa FROM merchant_payment_config
           WHERE merchant_code = ANY($1::text[]) AND COALESCE(poolpay->>'settlement_vpa','') <> ''`, [codes]).catch(() => [])
      : [];
    const vpas = vpaRows.map((r) => r.vpa).filter(Boolean);
    // Scope to the provider's branches by merchant (the inbox/device that captured the
    // credit is merchant-tagged) OR by settlement VPA (when the alert carries a payee).
    const where = scoped ? "WHERE (merchant_id = ANY($1::text[]) OR payee_vpa = ANY($2::text[]))" : "WHERE direction = 'CREDIT'";
    const args = scoped ? [codes, vpas.length ? vpas : ["__none__"]] : [];
    const recent = await rows<Alert>("vendorGateway", `
      SELECT id::text, source, bank, amount::float AS amount, utr, order_ref, payer_vpa, payee_vpa, narration,
             matched_order_ref, outcome, match_confidence, event_time, created_at
        FROM vendor_txn_alerts ${where}
       ORDER BY created_at DESC LIMIT 200
    `, args).catch(() => []);

    // A credit is "missing its RRN" when no 12-digit UPI reference has landed for it.
    // We only flag ones older than a short grace window so a just-arrived email (whose
    // screen-reader RRN is seconds behind) isn't counted as a miss.
    const hasRrn = (u: string | null) => !!u && /^\d{12}$/.test(u);
    const GRACE_MS = 5 * 60 * 1000;
    const missingRrn = recent.filter(
      (r) => !hasRrn(r.utr) && Date.now() - new Date(r.created_at).getTime() > GRACE_MS,
    ).length;
    const totals = {
      count: recent.length,
      gross: recent.reduce((a, r) => a + Number(r.amount || 0), 0),
      confirmed: recent.filter((r) => r.outcome === "CONFIRMED").length,
      unmatched: recent.filter((r) => r.outcome === "UNMATCHED" || r.outcome === "AMBIGUOUS").length,
      missingRrn,
    };
    return NextResponse.json({ vpas, totals, recent });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

function empty() { return { count: 0, gross: 0, confirmed: 0, unmatched: 0, missingRrn: 0 }; }
