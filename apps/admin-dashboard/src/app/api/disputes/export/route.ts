// GET /api/disputes/export — chargebacks / disputes as CSV.
//
// Same persona scoping as the list at /api/disputes: a merchant sees its own, a
// provider sees only its mapped merchants', an admin sees the tenant. Optional
// ?status= narrows it.
//
// Amounts are stored in minor units; the CSV reports rupees, because the file exists
// to be reconciled against a bank statement, not to be re-parsed by us.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { toCsv, csvResponse, datedFilename, type CsvColumn } from "@/lib/csv";

export const dynamic = "force-dynamic";

interface Row {
  dispute_id: string; txn_id: string; order_id: string | null; merchant_id: string;
  reason_code: string; amount_minor: string; currency: string; status: string;
  deadline_at: string | null; opened_at: string; opened_by: string;
  resolved_at: string | null; resolved_by: string; resolution_notes: string;
}

// Every currency Katana handles today is 2-decimal. A zero-decimal currency (JPY)
// would need an exponent lookup here rather than a flat divide.
const major = (minor: string) => {
  const n = Number(minor);
  return Number.isFinite(n) ? (n / 100).toFixed(2) : "";
};

const COLUMNS: CsvColumn<Row>[] = [
  { header: "Dispute ID", value: (r) => r.dispute_id },
  { header: "Opened", value: (r) => r.opened_at },
  { header: "Transaction ref", value: (r) => r.txn_id, ref: true },
  { header: "Banker", value: (r) => r.merchant_id },
  { header: "Reason code", value: (r) => r.reason_code },
  { header: "Amount", value: (r) => major(r.amount_minor) },
  { header: "Currency", value: (r) => r.currency },
  { header: "Status", value: (r) => r.status },
  { header: "Respond by", value: (r) => r.deadline_at },
  { header: "Opened by", value: (r) => r.opened_by },
  { header: "Resolved", value: (r) => r.resolved_at },
  { header: "Resolved by", value: (r) => r.resolved_by },
  { header: "Notes", value: (r) => r.resolution_notes },
  { header: "Order ID", value: (r) => r.order_id },
];

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const status = new URL(req.url).searchParams.get("status");

  try {
    const where: string[] = ["tenant_id='tenant-default'"];
    const params: unknown[] = [];

    if (s.persona === "MERCHANT") { params.push(s.scope_id); where.push(`merchant_id = $${params.length}`); }
    if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      // No mapped merchants means no disputes to see — an empty file, not everyone's.
      if (!ids.length) return csvResponse(datedFilename("chargebacks"), toCsv(COLUMNS, []));
      params.push(ids);
      where.push(`merchant_id = ANY($${params.length}::text[])`);
    }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }

    const list = await rows<Row>("riskVelocity", `
      SELECT dispute_id::text, txn_id, order_id::text, merchant_id, reason_code,
             amount_minor::text, currency, status, deadline_at,
             opened_at, COALESCE(opened_by,'') AS opened_by,
             resolved_at, COALESCE(resolved_by,'') AS resolved_by,
             COALESCE(resolution_notes,'') AS resolution_notes
        FROM disputes
       WHERE ${where.join(" AND ")}
       ORDER BY opened_at DESC LIMIT 10000
    `, params).catch(() => []);

    return csvResponse(datedFilename("chargebacks"), toCsv(COLUMNS, list));
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
