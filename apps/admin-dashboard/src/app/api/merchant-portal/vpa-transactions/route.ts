// Captured VPA credit transactions (bank/UPI credits landing on the provider's
// branches' settlement VPAs) for the provider dashboard. Sourced from
// vendor_txn_alerts (the Transaction-Intelligence raw credit store) and scoped by
// the settlement VPAs of the provider's mapped branches.
//   PROVIDER only (middleware restricts /api/merchant-portal/* to PROVIDER).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { settlementVpasFor } from "@/lib/settlement-vpa";
import { verificationOf } from "@/lib/credit-verification";

export const dynamic = "force-dynamic";

// Newest N credits. The dashboard's KPI tiles are computed from exactly this set, so the
// cap bounds the totals as well as the list — which is why the response reports when it has
// been hit rather than letting a plateaued "total" read as the real number.
const FEED_LIMIT = 1000;

interface Alert {
  id: string; source: string; bank: string | null; amount: number; utr: string | null;
  order_ref: string | null; payer_vpa: string | null; payee_vpa: string | null; narration: string | null;
  matched_order_ref: string | null; outcome: string; match_confidence: number;
  event_time: string | null; created_at: string;
  /** Who paid, as stated by the capturing screen. */
  payer_name: string | null;
  /** Everything else that screen said about the payment; shape varies per source. */
  details: Record<string, string> | null;
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
    // A branch can be configured with several (one primary payee + additional IDs it also
    // receives on); all of them are recognised here.
    const vpas = scoped ? await settlementVpasFor(codes) : [];
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
             matched_order_ref, outcome, match_confidence, event_time, created_at,
             payer_name, details
        FROM vendor_txn_alerts ${where}
       ORDER BY created_at DESC LIMIT ${FEED_LIMIT}
    `, args).catch(() => []);

    // A credit is "missing its RRN" when no 12-digit UPI reference has landed for it.
    // We only flag ones older than a short grace window so a just-arrived email (whose
    // screen-reader RRN is seconds behind) isn't counted as a miss.
    const hasRrn = (u: string | null) => !!u && /^\d{12}$/.test(u);
    const GRACE_MS = 5 * 60 * 1000;
    const missingRrn = recent.filter(
      (r) => !hasRrn(r.utr) && Date.now() - new Date(r.created_at).getTime() > GRACE_MS,
    ).length;

    // Verification, not order matching. A direct VPA collection has no Katana order, so its
    // `outcome` stays UNMATCHED forever — reporting that as the headline made every healthy
    // payment look broken (16 unmatched / 0 confirmed on a day when all 16 were real).
    // The banker portal has read these as "verified" since the RRN landed; this is the same
    // rule, so both portals now agree on the same payment.
    const withVerification = recent.map((r) => ({ ...r, verification: verificationOf(r, vpas) }));

    const totals = {
      count: recent.length,
      gross: recent.reduce((a, r) => a + Number(r.amount || 0), 0),
      // Kept for any caller still reading them, but the dashboard now leads with the
      // verification counts below.
      confirmed: recent.filter((r) => r.outcome === "CONFIRMED").length,
      unmatched: recent.filter((r) => r.outcome === "UNMATCHED" || r.outcome === "AMBIGUOUS").length,
      missingRrn,
      verified: withVerification.filter((r) => r.verification === "verified" || r.verification === "matched").length,
      awaitingRrn: withVerification.filter((r) => r.verification === "awaiting").length,
      vpaMismatch: withVerification.filter((r) => r.verification === "vpa_mismatch").length,
    };
    return NextResponse.json({
      vpas, totals, recent: withVerification, branches: codes, branch,
      // True when there are older credits beyond this window; the totals then describe the
      // newest FEED_LIMIT, not all time. Use the Statements download for a full period.
      truncated: recent.length >= FEED_LIMIT,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

function empty() { return { count: 0, gross: 0, confirmed: 0, unmatched: 0, missingRrn: 0 }; }
