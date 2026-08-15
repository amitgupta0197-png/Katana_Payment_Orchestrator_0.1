// Captured VPA credit transactions (bank/UPI credits landing on the provider's
// branches' settlement VPAs) for the provider dashboard. Sourced from
// vendor_txn_alerts (the Transaction-Intelligence raw credit store) and scoped by
// the settlement VPAs of the provider's mapped branches.
//   PROVIDER only (middleware restricts /api/merchant-portal/* to PROVIDER).

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

export async function GET(req: Request) {
  const g = await gateOrResponse(["PROVIDER", "SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  try {
    const scoped = s.persona === "PROVIDER";
    const codes = await resolveProviderMerchants(s);
    if (scoped && !codes.length) return NextResponse.json({ vpas: [], totals: empty(), recent: [], branches: [], branch: null });

    // ?branch=CODE narrows the feed to ONE banker code — the code configured in that
    // device's Katana agent. Scope-checked against the provider's own branches so a
    // provider cannot read another provider's traffic by guessing a code.
    const url = new URL(req.url);
    const branchParam = url.searchParams.get("branch")?.trim() || null;
    const branch = branchParam && (!scoped || codes.includes(branchParam)) ? branchParam : null;
    if (branchParam && !branch) {
      return NextResponse.json({ error: "branch out of scope" }, { status: 403 });
    }

    // Settlement VPAs of the provider's branches — the accounts these credits land on.
    const vpaRows = scoped
      ? await rows<{ vpa: string }>("merchant", `
          SELECT DISTINCT poolpay->>'settlement_vpa' AS vpa FROM merchant_payment_config
           WHERE merchant_code = ANY($1::text[]) AND COALESCE(poolpay->>'settlement_vpa','') <> ''`, [codes]).catch(() => [])
      : [];
    const vpas = vpaRows.map((r) => r.vpa).filter(Boolean);
    // DUPLICATE rows are the SAME payment seen a second time — the reconciler marks them
    // when one credit reaches us on two channels (a GPay push and the on-device screen read
    // of the same transaction). Showing them makes one payment look like several, and they
    // would also double-count into `gross` below, so they are excluded from the feed and the
    // totals alike.
    const notDup = "COALESCE(outcome,'') <> 'DUPLICATE'";

    // SEGREGATION BY BANKER CODE.
    //
    // The banker code typed into a device's Katana agent is stored on every credit it
    // captures (merchant_id), and that is the ONLY trustworthy way to tell one banker's
    // traffic from another's. Settlement VPAs are not: PRIMESX and PRVZS23 are both
    // configured with 9355449766@okbizaxis, so an unqualified `OR payee_vpa = ANY(...)`
    // showed every credit on that account under BOTH codes and made the agent's banker
    // code look ignored (client report, 2026-08-15).
    //
    // So payee_vpa is now only a FALLBACK for rows that carry no banker code at all —
    // it can never pull a credit that belongs to one banker into another's view. When a
    // specific branch is selected we match on merchant_id alone: an untagged credit
    // cannot be attributed to a branch, so it stays in the all-branches view where it is
    // visible as something to fix, rather than being silently assigned.
    let where: string;
    let args: unknown[];
    if (branch) {
      where = `WHERE merchant_id = $1 AND ${notDup}`;
      args = [branch];
    } else if (scoped) {
      where = `WHERE (merchant_id = ANY($1::text[]) OR (merchant_id IS NULL AND payee_vpa = ANY($2::text[]))) AND ${notDup}`;
      args = [codes, vpas.length ? vpas : ["__none__"]];
    } else {
      where = `WHERE direction = 'CREDIT' AND ${notDup}`;
      args = [];
    }
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
    return NextResponse.json({ vpas, totals, recent, branches: codes, branch });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

function empty() { return { count: 0, gross: 0, confirmed: 0, unmatched: 0, missingRrn: 0 }; }
