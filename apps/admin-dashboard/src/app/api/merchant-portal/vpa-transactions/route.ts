// Captured VPA credit transactions (bank/UPI credits landing on the provider's
// branches' settlement VPAs) for the provider dashboard. Sourced from
// vendor_txn_alerts (the Transaction-Intelligence raw credit store) and scoped by
// the settlement VPAs of the provider's mapped branches.
//   PROVIDER only (middleware restricts /api/merchant-portal/* to PROVIDER).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { settlementVpasFor } from "@/lib/settlement-vpa";
import { verificationOf, isProven, sumAmount } from "@/lib/credit-verification";
import { IS_COLLECTION, IS_SETTLEMENT } from "@/lib/settlement-credit";

export const dynamic = "force-dynamic";

// Newest N credits. The dashboard's KPI tiles are computed from exactly this set, so the
// cap bounds the totals as well as the list — which is why the response reports when it has
// been hit rather than letting a plateaued "total" read as the real number.
const FEED_LIMIT = 1000;

interface Alert {
  id: string; source: string; bank: string | null; amount: number; utr: string | null;
  order_ref: string | null; payer_vpa: string | null; payee_vpa: string | null; narration: string | null;
  /** Banker code the capturing agent stamped — the credit's real owner, and what the UI shows
   *  when the payment itself did not state which settlement VPA received it. */
  merchant_id: string | null;
  /** Phone that captured this credit; with `payee_vpa_source = 'DEVICE'` it is where the
   *  destination VPA came from, so the UI can show the derivation rather than imply the
   *  payment named it. */
  device_id: string | null;
  /** STATED (the capture named the payee VPA) | DEVICE (from the capturing phone's mapping)
   *  | null (unknown — the row shows the banker's settlement account). */
  payee_vpa_source: string | null;
  /** App package / SMS header that reported this credit — with `bank`, it identifies the app. */
  sender: string | null;
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
    // WHAT COUNTS AS COLLECTED MONEY. Two classes of row are excluded from the feed and from
    // every total below, for the same reason: neither is new money.
    //
    //   DUPLICATE  — the same payment seen a second time (a GPay push and the on-device screen
    //                read of one transaction). Showing it makes one payment look like several.
    //   SETTLEMENT — the payment app moving money it already holds into the bank account
    //                ("₹40,006 for transactions settled to your bank account"). That is
    //                yesterday's collections travelling one leg further, and counting it stated
    //                the same takings twice (₹125,046 of phantom gross, 2026-08-17).
    //
    // Both live in one shared predicate so this screen, the banker portal, the statements and
    // the Telegram report cannot drift apart on what "collected" means.
    const isCollection = IS_COLLECTION;

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
    // Ownership half of the filter, shared by the collection feed and the settlement feed so
    // both describe the same accounts.
    let owned: string;
    let args: unknown[];
    if (branch) {
      owned = `merchant_id = $1`;
      args = [branch];
    } else if (scoped) {
      owned = `(merchant_id = ANY($1::text[]) OR (merchant_id IS NULL AND payee_vpa = ANY($2::text[])))`;
      args = [codes, vpas.length ? vpas : ["__none__"]];
    } else {
      owned = `direction = 'CREDIT'`;
      args = [];
    }
    const FEED_COLS = `id::text, source, bank, amount::float AS amount, utr, order_ref, payer_vpa, payee_vpa, narration,
             matched_order_ref, outcome, match_confidence, event_time, created_at,
             payer_name, details, merchant_id, device_id, payee_vpa_source, sender`;
    const recent = await rows<Alert>("vendorGateway", `
      SELECT ${FEED_COLS}
        FROM vendor_txn_alerts WHERE ${owned} AND ${isCollection}
       ORDER BY created_at DESC LIMIT ${FEED_LIMIT}
    `, args).catch(() => []);

    // The settlement legs, listed separately. Not collected money — but worth showing, because
    // this is the record of collected money actually reaching the bank account, and because a
    // settlement that has been filtered out of the totals must still be visible somewhere or
    // the phone's upload looks like it vanished.
    const settlements = await rows<Alert>("vendorGateway", `
      SELECT ${FEED_COLS}
        FROM vendor_txn_alerts WHERE ${owned} AND ${IS_SETTLEMENT}
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

    // Verification, not order matching. A direct VPA collection has no Katana order, so its
    // `outcome` stays UNMATCHED forever — reporting that as the headline made every healthy
    // payment look broken (16 unmatched / 0 confirmed on a day when all 16 were real).
    // The banker portal has read these as "verified" since the RRN landed; this is the same
    // rule, so both portals now agree on the same payment.
    const withVerification = recent.map((r) => ({ ...r, verification: verificationOf(r, vpas) }));

    // MONEY IS REPORTED IN THREE BUCKETS, NEVER AS ONE NUMBER.
    //
    // A credit with no RRN is a claim the network has not corroborated yet. Folding it into the
    // received total presents unproven money as banked money — and since most such rows do get
    // their RRN minutes later, the total kept drifting upwards for reasons nobody could tie to a
    // payment. Proven money is the headline; the rest sits beside it, added to nothing.
    const proven   = withVerification.filter((r) => isProven(r.verification));
    const awaiting = withVerification.filter((r) => r.verification === "awaiting");
    const mismatch = withVerification.filter((r) => r.verification === "vpa_mismatch");

    const totals = {
      count: recent.length,
      // Every collection added together, proven or not. Kept for reconciliation and for callers
      // that need the all-in figure; the dashboard leads with `verifiedAmount` instead, and
      // gross === verifiedAmount + awaitingAmount + mismatchAmount always holds.
      gross: sumAmount(recent),
      // Kept for any caller still reading them, but the dashboard now leads with the
      // verification counts below.
      confirmed: recent.filter((r) => r.outcome === "CONFIRMED").length,
      unmatched: recent.filter((r) => r.outcome === "UNMATCHED" || r.outcome === "AMBIGUOUS").length,
      missingRrn,
      verified: proven.length,
      awaitingRrn: awaiting.length,
      vpaMismatch: mismatch.length,
      // Money proven by a UPI RRN (or by a confirmed order match) — the collected total.
      verifiedAmount: sumAmount(proven),
      // Claimed but not yet corroborated. Reported, never added to the total above.
      awaitingAmount: sumAmount(awaiting),
      // Credits naming a payee VPA that belongs to no configured banker — a flagged problem,
      // counted separately so it can neither inflate the total nor be quietly lost.
      mismatchAmount: sumAmount(mismatch),
      // Money the payment app has paid out to the bank account. Reported separately and never
      // added to `gross` — it is the same money as the collections above, one leg later.
      settledCount: settlements.length,
      settled: settlements.reduce((a, r) => a + Number(r.amount || 0), 0),
    };
    return NextResponse.json({
      vpas, totals, recent: withVerification, settlements, branches: codes, branch,
      // True when there are older credits beyond this window; the totals then describe the
      // newest FEED_LIMIT, not all time. Use the Statements download for a full period.
      truncated: recent.length >= FEED_LIMIT,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

function empty() { return { count: 0, gross: 0, confirmed: 0, unmatched: 0, missingRrn: 0 }; }
