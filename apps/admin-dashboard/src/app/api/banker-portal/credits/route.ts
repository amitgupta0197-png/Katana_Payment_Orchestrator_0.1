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
}

export async function GET() {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;
  const code = g.session.scope_id;
  if (!code) return NextResponse.json({ error: "MERCHANT session missing scope_id" }, { status: 400 });

  // Some credits arrive attributed only by the VPA that was credited (e.g. an email alert
  // with no merchant id), so match on this banker's settlement VPA as well as its code.
  const vpas = (await rows<{ vpa: string }>(
    "merchant",
    `SELECT DISTINCT poolpay->>'settlement_vpa' AS vpa FROM merchant_payment_config
      WHERE merchant_code = $1 AND COALESCE(poolpay->>'settlement_vpa','') <> ''`,
    [code],
  ).catch(() => [])).map((r) => r.vpa);

  const recent = await rows<CreditRow>(
    "vendorGateway",
    `SELECT id::text, source, device_id, COALESCE(amount,0)::float AS amount,
            payer_vpa, payee_vpa, utr, narration, outcome, match_confidence,
            matched_order_ref, detail, event_time, created_at
       FROM vendor_txn_alerts
      WHERE direction = 'CREDIT' AND (merchant_id = $1 OR payee_vpa = ANY($2::text[]))
      ORDER BY created_at DESC
      LIMIT 50`,
    [code, vpas],
  ).catch(() => []);

  // Test alerts must never inflate real money. The agent's "Test" button posts a fixed
  // synthetic notification — MainActivity.sendTestAlert() builds
  // "Rs.1.00 credited to test@upi UPI Ref <n>" — so the payer VPA is the marker. Real
  // payers are never test@upi.
  const withFlag = recent.map((r) => ({ ...r, is_test: r.payer_vpa === TEST_PAYER_VPA }));
  const real = withFlag.filter((r) => !r.is_test);
  const tests = withFlag.filter((r) => r.is_test);

  const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
  const todayReal = real.filter((r) => isToday(r.created_at));

  return NextResponse.json({
    // Real credits only — the UI lists these and every total below counts only these.
    credits: real,
    // Test alerts are returned separately so the UI can show them without mixing them in.
    test_credits: tests,
    summary: {
      total: real.length,
      confirmed: real.filter((r) => r.outcome === "CONFIRMED").length,
      unmatched: real.filter((r) => r.outcome === "UNMATCHED" || r.outcome === "AMBIGUOUS").length,
      today_count: todayReal.length,
      today_amount: +todayReal.reduce((s, r) => s + (r.amount ?? 0), 0).toFixed(2),
      last_at: real[0]?.created_at ?? null,
      test_count: tests.length,
      test_amount: +tests.reduce((s, r) => s + (r.amount ?? 0), 0).toFixed(2),
    },
  });
}
