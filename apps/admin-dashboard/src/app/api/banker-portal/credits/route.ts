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

  const today = recent.filter((r) => {
    const d = new Date(r.created_at);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  });

  return NextResponse.json({
    credits: recent,
    summary: {
      total: recent.length,
      confirmed: recent.filter((r) => r.outcome === "CONFIRMED").length,
      unmatched: recent.filter((r) => r.outcome === "UNMATCHED" || r.outcome === "AMBIGUOUS").length,
      today_count: today.length,
      today_amount: +today.reduce((s, r) => s + (r.amount ?? 0), 0).toFixed(2),
      last_at: recent[0]?.created_at ?? null,
    },
  });
}
