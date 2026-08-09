// GET /api/merchant-portal/transactions/export — transactions as CSV.
//
// Same union and the same scoping as the list route, but enriched with the gateway
// detail (payment id, bank reference, UPI handle) because that is what a merchant is
// actually reconciling against a bank statement. Optional ?from=&to=&status= narrow it.
//
// PROVIDER only, scoped to the provider's own merchants.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { toCsv, csvResponse, datedFilename, type CsvColumn } from "@/lib/csv";

export const dynamic = "force-dynamic";

interface Row {
  source: string; merchant_id: string; channel: string; method: string; status: string;
  amount: number; ref: string; txn_id: string | null; created_at: string;
  provider_payment_id: string | null; bank_ref_num: string | null; vpa: string | null;
  payment_type: string | null; bank_name: string | null; customer_email: string | null;
}

const COLUMNS: CsvColumn<Row>[] = [
  { header: "Date", value: (r) => r.created_at },
  { header: "Reference", value: (r) => r.txn_id ?? r.ref },
  { header: "Banker", value: (r) => r.merchant_id },
  { header: "Channel", value: (r) => r.channel },
  { header: "Method", value: (r) => r.payment_type || r.method },
  { header: "Amount", value: (r) => r.amount },
  { header: "Status", value: (r) => r.status },
  { header: "Gateway payment ID", value: (r) => r.provider_payment_id, ref: true },
  { header: "Bank ref / RRN", value: (r) => r.bank_ref_num, ref: true },
  { header: "UPI ID", value: (r) => r.vpa },
  { header: "Bank", value: (r) => r.bank_name },
  { header: "Customer email", value: (r) => r.customer_email },
  { header: "Order ID", value: (r) => r.ref },
];

/**
 * The two sources live in different databases and different column names, so each
 * gets its own WHERE built against its own aliases. Same filter values, same $n
 * order — the parameter array is shared.
 */
function conditions(prefix: string, opts: {
  codes: string[] | null; from: string | null; to: string | null; status: string | null;
}) {
  const args: unknown[] = [];
  const cond: string[] = [];
  if (opts.codes) { args.push(opts.codes); cond.push(`${prefix}merchant_id = ANY($${args.length}::text[])`); }
  if (opts.from) { args.push(opts.from); cond.push(`${prefix}created_at >= $${args.length}::timestamptz`); }
  if (opts.to) { args.push(opts.to); cond.push(`${prefix}created_at < ($${args.length}::timestamptz + interval '1 day')`); }
  if (opts.status) { args.push(opts.status.toUpperCase()); cond.push(`${prefix}status = $${args.length}`); }
  return { where: cond.length ? "WHERE " + cond.join(" AND ") : "", args };
}

export async function GET(req: Request) {
  const g = await gateOrResponse(["PROVIDER", "SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);

  try {
    const codes = await resolveProviderMerchants(s);
    const scoped = s.persona === "PROVIDER";
    if (scoped && !codes.length) return csvResponse(datedFilename("transactions"), toCsv(COLUMNS, []));

    const opts = {
      codes: scoped ? codes : null,
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      status: url.searchParams.get("status"),
    };
    const co = conditions("o.", opts);
    const vp = conditions("", opts);

    const checkout = await rows<Row>("checkout", `
      SELECT 'CHECKOUT' AS source, o.merchant_id,
             COALESCE(NULLIF(o.selected_rail,''),'DIRECT') AS channel,
             COALESCE(o.method,'') AS method, o.status, o.amount::float AS amount,
             o.id::text AS ref, o.txn_id, o.created_at, o.customer_email,
             d.provider_payment_id, d.bank_ref_num, d.vpa, d.payment_type, d.bank_name
        FROM checkout_orders o
        LEFT JOIN payment_details d ON d.order_id = o.id
        ${co.where}
       ORDER BY o.created_at DESC LIMIT 10000
    `, co.args).catch(() => []);

    const payin = await rows<Row>("vendorGateway", `
      SELECT 'PAYIN' AS source, merchant_id, vendor AS channel,
             COALESCE(channel,'') AS method, status, amount::float AS amount,
             order_id AS ref, order_id AS txn_id, created_at,
             NULL::text AS customer_email, vendor_txn_id AS provider_payment_id,
             rrn AS bank_ref_num, customer_vpa AS vpa,
             NULL::text AS payment_type, NULL::text AS bank_name
        FROM vendor_payin_orders
       ${vp.where || "WHERE merchant_id IS NOT NULL"}
       ORDER BY created_at DESC LIMIT 10000
    `, vp.args).catch(() => []);

    const all = [...checkout, ...payin]
      .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));

    return csvResponse(datedFilename("transactions"), toCsv(COLUMNS, all));
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
