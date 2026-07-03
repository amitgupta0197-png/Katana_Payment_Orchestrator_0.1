// Provider transactions + gross value across ALL channels for the provider's
// assigned merchants (for reimbursement). Unions checkout_orders (PayU / Cashfree
// / Razorpay / … via selected_rail) and vendor_payin_orders (PoolPay / Quickpay).
//
// PROVIDER only (middleware restricts /api/provider-portal/* to PROVIDER persona).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

const SUCCESS = new Set(["SUCCESS", "SUCCEEDED"]);
const FAILED = new Set(["FAILED", "EXPIRED"]);

interface Txn { source: string; merchant_id: string; channel: string; method: string; status: string; amount: number; ref: string; created_at: string }

export async function GET() {
  const g = await gateOrResponse(["PROVIDER", "SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;

  try {
    const codes = await resolveProviderMerchants(s);
    // SUPER_ADMIN preview falls back to all merchants (no filter); PROVIDER with no
    // mapped merchants gets an empty dashboard rather than everyone's data.
    const scoped = s.persona === "PROVIDER";
    if (scoped && !codes.length) {
      return NextResponse.json({ merchants: [], totals: empty(), by_merchant: [], by_channel: [], recent: [], series: [] });
    }

    const coFilter = scoped ? "WHERE merchant_id = ANY($1::text[])" : "";
    const checkout = await rows<Txn>("checkout", `
      SELECT 'CHECKOUT' AS source, merchant_id,
             COALESCE(NULLIF(selected_rail,''),'DIRECT') AS channel,
             COALESCE(method,'') AS method, status, amount::float AS amount,
             id::text AS ref, created_at
        FROM checkout_orders ${coFilter}
       ORDER BY created_at DESC LIMIT 500
    `, scoped ? [codes] : []).catch(() => []);

    const vpFilter = scoped ? "WHERE merchant_id = ANY($1::text[])" : "WHERE merchant_id IS NOT NULL";
    const payin = await rows<Txn>("vendorGateway", `
      SELECT 'PAYIN' AS source, merchant_id, vendor AS channel,
             COALESCE(channel,'') AS method, status, amount::float AS amount,
             order_id AS ref, created_at
        FROM vendor_payin_orders ${vpFilter}
       ORDER BY created_at DESC LIMIT 500
    `, scoped ? [codes] : []).catch(() => []);

    const all = [...checkout, ...payin];

    const totals = empty();
    const byMerchant = new Map<string, { merchant_id: string; gross: number; count: number; success: number }>();
    const byChannel = new Map<string, { channel: string; gross: number; count: number }>();

    for (const t of all) {
      const ok = SUCCESS.has(t.status);
      totals.total_count++;
      if (ok) { totals.success_count++; totals.gross += t.amount; }
      else if (FAILED.has(t.status)) totals.failed_count++;
      else totals.pending_count++;

      const mk = t.merchant_id || "—";
      const m = byMerchant.get(mk) ?? { merchant_id: mk, gross: 0, count: 0, success: 0 };
      m.count++; if (ok) { m.gross += t.amount; m.success++; }
      byMerchant.set(mk, m);

      const ch = t.channel || "—";
      const c = byChannel.get(ch) ?? { channel: ch, gross: 0, count: 0 };
      c.count++; if (ok) c.gross += t.amount;
      byChannel.set(ch, c);
    }

    const recent = all
      .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
      .slice(0, 60);

    return NextResponse.json({
      merchants: codes,
      totals,
      by_merchant: [...byMerchant.values()].sort((a, b) => b.gross - a.gross),
      by_channel: [...byChannel.values()].sort((a, b) => b.gross - a.gross),
      recent,
      series: buildDaySeries(all),
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

// Last-N-day daily rollup for the dashboard trend charts.
function buildDaySeries(all: Txn[], days = 14) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const buckets: { label: string; total: number; success: number; failed: number; gross: number }[] = [];
  const index = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    index.set(d.toDateString(), buckets.length);
    buckets.push({ label: `${d.getDate()}/${d.getMonth() + 1}`, total: 0, success: 0, failed: 0, gross: 0 });
  }
  for (const t of all) {
    const k = new Date(t.created_at); k.setHours(0, 0, 0, 0);
    const idx = index.get(k.toDateString());
    if (idx === undefined) continue;
    const b = buckets[idx];
    b.total++;
    if (SUCCESS.has(t.status)) { b.success++; b.gross += t.amount; }
    else if (FAILED.has(t.status)) b.failed++;
  }
  return buckets;
}

function empty() {
  return { gross: 0, success_count: 0, failed_count: 0, pending_count: 0, total_count: 0 };
}
