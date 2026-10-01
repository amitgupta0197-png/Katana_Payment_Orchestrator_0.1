// GET /api/payin-flows/{p2p|intent}/orders — the orders of one pay-in flow, read from that
// flow's own table (vendorGateway 0030) joined to the shared order core.
//
//   p2p     katana_p2p_orders      P2P-…  payee UPI ID, payer, UTR and how it was evidenced
//   intent  katana_intent_orders   INT-…  gateway, its transaction and payment ids, bank reference
//
// ?from=&to= are IST calendar days; ?status=, ?merchant= (banker code) and ?q= (a reference,
// order id or UTR) narrow further. Follows the dashboard's Test / Live switch. Totals cover the
// whole window; the rows are the newest 200.
//
// SUPER_ADMIN only: the Intent list names the gateway.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { getLivemode } from "@/lib/mode";

export const dynamic = "force-dynamic";

const ROW_LIMIT = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const FLOWS = {
  p2p: {
    table: "katana_p2p_orders",
    cols: `f.p2p_ref AS ref, f.pay_mode, f.payee_vpa, f.payer_vpa, f.utr, f.evidence, f.confirmed_by, f.confirmed_at,
           f.proof_status, f.on_hold, f.hold_reason`,
    search: ["f.p2p_ref", "f.utr", "f.payee_vpa"],
  },
  intent: {
    table: "katana_intent_orders",
    cols: `f.intent_ref AS ref, f.gateway, f.gateway_env, f.gateway_txn_id, f.gateway_payment_id, f.bank_ref,
           f.evidence, f.confirmed_by, f.confirmed_at, f.payout_status, f.payout_at,
           (f.checkout_url IS NOT NULL) AS hosted_page`,
    search: ["f.intent_ref", "f.bank_ref", "f.gateway_txn_id", "f.gateway_payment_id"],
  },
} as const;

export async function GET(req: Request, { params }: { params: Promise<{ flow: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const key = (await params).flow.toLowerCase();
  if (key !== "p2p" && key !== "intent") return NextResponse.json({ error: "unknown flow" }, { status: 404 });
  const f = FLOWS[key];

  const sp = new URL(req.url).searchParams;
  const from = sp.get("from"), to = sp.get("to");
  const where: string[] = ["f.livemode = $1"];
  const args: unknown[] = [await getLivemode()];
  const add = (sql: (p: string) => string, v: unknown) => { args.push(v); where.push(sql(`$${args.length}`)); };
  // A date is an IST calendar day (see lib/txn-window for why the cast goes through ::timestamp).
  if (from && DATE_RE.test(from)) add((p) => `o.created_at >= (${p}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`, from);
  if (to && DATE_RE.test(to)) add((p) => `o.created_at < (${p}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`, to);
  const status = sp.get("status")?.toUpperCase();
  if (status) add((p) => `o.status = ${p}`, status);
  const merchant = sp.get("merchant")?.trim();
  if (merchant) add((p) => `f.merchant_id = ${p}`, merchant);
  const q = sp.get("q")?.trim();
  if (q) add((p) => `(${[...f.search, "o.order_id", "o.vendor_txn_id"].map((c) => `${c} ILIKE ${p}`).join(" OR ")})`, `%${q}%`);

  const fromSql = `FROM ${f.table} f JOIN vendor_payin_orders o ON o.id = f.order_id WHERE ${where.join(" AND ")}`;
  try {
    const [totals, byStatus, byMerchant, orders] = await Promise.all([
      rows<{ n: number; amount: number; paid_n: number; paid_amount: number }>("vendorGateway", `
        SELECT COUNT(*)::int AS n, COALESCE(SUM(o.amount),0)::float AS amount,
               COUNT(*) FILTER (WHERE o.status IN ('SUCCESS','SUCCEEDED'))::int AS paid_n,
               COALESCE(SUM(o.amount) FILTER (WHERE o.status IN ('SUCCESS','SUCCEEDED')),0)::float AS paid_amount
          ${fromSql}`, args),
      rows<{ status: string; n: number; amount: number }>("vendorGateway", `
        SELECT o.status, COUNT(*)::int AS n, COALESCE(SUM(o.amount),0)::float AS amount ${fromSql} GROUP BY o.status ORDER BY n DESC`, args),
      rows<{ merchant_id: string; n: number; paid_amount: number }>("vendorGateway", `
        SELECT COALESCE(f.merchant_id, '—') AS merchant_id, COUNT(*)::int AS n,
               COALESCE(SUM(o.amount) FILTER (WHERE o.status IN ('SUCCESS','SUCCEEDED')),0)::float AS paid_amount
          ${fromSql} GROUP BY 1 ORDER BY paid_amount DESC, n DESC LIMIT 50`, args),
      rows<Record<string, unknown>>("vendorGateway", `
        SELECT o.id::text, o.order_id, f.merchant_id, o.amount::float AS amount, o.currency_code, o.status,
               o.created_at, o.updated_at, ${f.cols}
          ${fromSql} ORDER BY o.created_at DESC LIMIT ${ROW_LIMIT}`, args),
    ]);
    return NextResponse.json({
      flow: key.toUpperCase(),
      totals: totals[0] ?? { n: 0, amount: 0, paid_n: 0, paid_amount: 0 },
      by_status: byStatus, by_merchant: byMerchant, orders,
      truncated: orders.length >= ROW_LIMIT,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
