// GET /api/banker-portal/credits — raw incoming UPI credits as the collection phone's
// agent reports them, for the banker that owns them.
//
// The banker's Transactions page lists checkout ORDERS. A credit that matches no order is
// therefore invisible there, which makes the agent look broken when it is working fine —
// the alert is stored, it simply has nothing to attach to. This endpoint exposes the raw
// feed so the person holding the phone can watch alerts land and see why one did not match.
//
// BANKER-scoped: the MERCHANT persona's scope_id IS the merchant_code that
// vendor_txn_alerts.merchant_id keys on, so a banker only ever sees its own credits.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { settlementVpasFor } from "@/lib/settlement-vpa";
import { verificationOf, isProven, sumAmount } from "@/lib/credit-verification";
import { IS_COLLECTION, IS_SETTLEMENT } from "@/lib/settlement-credit";
import { rows } from "@/lib/pg";

export const dynamic = "force-dynamic";

// Payer VPA the agent's built-in "Test" button always uses. Keep in sync with
// MainActivity.sendTestAlert() in apps/android-agent.
const TEST_PAYER_VPA = "test@upi";

interface CreditRow {
  id: string; source: string; device_id: string | null; amount: number;
  payer_vpa: string | null; payee_vpa: string | null; utr: string | null;
  narration: string | null; outcome: string; match_confidence: number;
  matched_order_ref: string | null; detail: string | null;
  event_time: string | null; created_at: string;
  /** Who paid, as stated by the capturing screen. */
  payer_name: string | null;
  /** Everything else that screen said about the payment; shape varies per source. */
  details: Record<string, string> | null;
  /** Which payment app the money arrived on — `bank` from a screen-read, `sender` from a push. */
  bank: string | null;
  sender: string | null;
}

export async function GET() {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;
  const code = g.session.scope_id;
  if (!code) return NextResponse.json({ error: "MERCHANT session missing scope_id" }, { status: 400 });

  // Some credits arrive attributed only by the VPA that was credited (e.g. an email alert
  // with no merchant id), so match on this banker's settlement VPA as well as its code.
  // Every UPI ID this banker receives on — the primary payee plus any additional ones
  // configured for it.
  const vpas = await settlementVpasFor([code]);

  const COLS = `id::text, source, device_id, COALESCE(amount,0)::float AS amount,
            payer_vpa, payee_vpa, utr, narration, outcome, match_confidence,
            matched_order_ref, detail, event_time, created_at,
            payer_name, details, bank, sender`;
  // Banker code first: branches can share a settlement VPA (PRIMESX and PRVZS23 are both
  // 9355449766@okbizaxis), so an unqualified payee_vpa match pulls another banker's credits
  // into this view. Fall back to the VPA only for untagged rows.
  const OWNED = `direction = 'CREDIT'
        AND (merchant_id = $1 OR (merchant_id IS NULL AND payee_vpa = ANY($2::text[])))`;

  // Only real collected money. Excluded, and why (shared predicate — see lib/settlement-credit):
  //   DUPLICATE  = one payment seen twice (a push and the on-device screen read). The
  //                reconciler folds the RRN and detail onto the row we keep, so the duplicate
  //                carries nothing unique; showing it makes one payment look like two.
  //   SETTLEMENT = the payment app paying its held balance into the bank account. Same money
  //                as the credits above, one leg later; listed on its own below.
  const recent = await rows<CreditRow>(
    "vendorGateway",
    `SELECT ${COLS} FROM vendor_txn_alerts
      WHERE ${OWNED} AND ${IS_COLLECTION}
      ORDER BY created_at DESC
      LIMIT 50`,
    [code, vpas],
  ).catch(() => []);

  // Settlement legs — proof that the collections above reached the bank account. Never added
  // to any collection total; shown so a filtered-out upload is still accounted for.
  const settlements = await rows<CreditRow>(
    "vendorGateway",
    `SELECT ${COLS} FROM vendor_txn_alerts
      WHERE ${OWNED} AND ${IS_SETTLEMENT}
      ORDER BY created_at DESC
      LIMIT 50`,
    [code, vpas],
  ).catch(() => []);

  // Test alerts must never inflate real money. The agent's "Test" button posts a fixed
  // synthetic notification — MainActivity.sendTestAlert() builds
  // "Rs.1.00 credited to test@upi UPI Ref <n>" — so the payer VPA is the marker. Real
  // payers are never test@upi.
  // VERIFICATION STATE (distinct from order matching).
  //
  // "unmatched" only ever meant "no pending Katana ORDER had this amount". For a direct VPA
  // collection there is no order by definition, so every healthy payment rendered as an amber
  // warning and the column carried no information.
  //
  // What actually proves a direct collection is the 12-digit RRN: it is the UPI network's own
  // reference, unique per transaction, and it exists only because a real transfer happened.
  //
  // The settlement VPA deliberately does NOT decide this. On the dominant capture path the
  // payee VPA is not reported by the payment at all -- txn-reconcile fills it in from this
  // merchant's own configured settlement VPA when the alert lacks one -- so testing it against
  // that same config compares a value to itself and passes always. It is used only in the one
  // case where it carries information: an alert that DID state a payee VPA, disagreeing with
  // every VPA configured for this banker, which is a genuine misconfiguration worth shouting
  // about.
  const withFlag = recent.map((r) => ({
    ...r,
    is_test: r.payer_vpa === TEST_PAYER_VPA,
    verification: verificationOf(r, vpas),
  }));
  const real = withFlag.filter((r) => !r.is_test);
  const tests = withFlag.filter((r) => r.is_test);

  const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
  const todayReal = real.filter((r) => isToday(r.created_at));
  // Today's money, split by whether the UPI network has corroborated it. A credit with no RRN
  // is a claim the phone reported; it usually firms up within minutes, but until it does it is
  // not banked money and is never added to the day's takings.
  const todayProven = todayReal.filter((r) => isProven(r.verification));
  const todayAwaiting = todayReal.filter((r) => r.verification === "awaiting");

  return NextResponse.json({
    // Real credits only — the UI lists these and every total below counts only these.
    credits: real,
    // Test alerts are returned separately so the UI can show them without mixing them in.
    test_credits: tests,
    // Settlements to the bank account — recorded, listed on their own, counted nowhere.
    settlements,
    summary: {
      total: real.length,
      confirmed: real.filter((r) => r.outcome === "CONFIRMED").length,
      unmatched: real.filter((r) => r.outcome === "UNMATCHED" || r.outcome === "AMBIGUOUS").length,
      // Collections proved by a real UPI reference, whether or not an order existed.
      verified: real.filter((r) => r.verification === "verified" || r.verification === "matched").length,
      awaiting_rrn: real.filter((r) => r.verification === "awaiting").length,
      vpa_mismatch: real.filter((r) => r.verification === "vpa_mismatch").length,
      today_count: todayReal.length,
      // All-in figure, kept for reconciliation: today_amount === today_verified_amount +
      // today_awaiting_amount + any VPA-mismatch money. The UI leads with the verified half.
      today_amount: sumAmount(todayReal),
      today_verified_amount: sumAmount(todayProven),
      today_awaiting_count: todayAwaiting.length,
      today_awaiting_amount: sumAmount(todayAwaiting),
      last_at: real[0]?.created_at ?? null,
      test_count: tests.length,
      test_amount: sumAmount(tests),
      settled_count: settlements.length,
      settled_amount: sumAmount(settlements),
    },
  });
}
