// The pay-in report a merchant pulls for itself (POST /api/v1/reports/payins): the orders of a
// date range with their totals, as JSON or CSV.
//
// It goes to a merchant, so it carries nothing that names a gateway: the flow (P2P / INTENT),
// the merchant's own reference, the amount, the status as the callback states it and the bank
// reference. Days are calendar days in India.
//
// `report_hash` is the SHA-256 of the report's content. A copy that has been edited no longer
// matches it, and the same range asked again while nothing changed gives the same hash.

import { createHash } from "crypto";
import { rows } from "@/lib/pg";
import { callbackStatus } from "@/lib/katana-pay";
import { toCsv, type CsvColumn } from "@/lib/csv";

export const REPORT_MAX_DAYS = 31;
export const REPORT_MAX_ORDERS = 10_000;

export interface ReportOrder {
  id: string;
  txnid: string;
  amount: string;
  currency: string;
  status: string;            // Captured | Failed | Expired | Pending
  flow: string | null;       // P2P | INTENT
  utr: string | null;
  created_at: string;
  paid_at: string | null;
}

export interface PayinReport {
  merchant: string;
  livemode: boolean;
  from: string;
  to: string;
  summary: {
    orders: number; paid_orders: number; paid_amount: string;
    failed_orders: number; expired_orders: number; pending_orders: number;
    /** Paid orders as a share of the orders that reached an end, 0 to 1; null when none has. */
    success_rate: number | null;
  };
  by_day: { date: string; orders: number; paid_orders: number; paid_amount: string }[];
  by_flow: { flow: string; orders: number; paid_orders: number; paid_amount: string }[];
  orders: ReportOrder[];
  /** True when the range holds more orders than one report carries; the totals still cover all of them. */
  truncated: boolean;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Why a date range cannot be reported, or null. */
export function validateReportRange(from: string, to: string): string | null {
  if (!DAY.test(from) || !DAY.test(to)) return "from and to are dates, YYYY-MM-DD";
  const a = Date.parse(from + "T00:00:00Z"), b = Date.parse(to + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return "from and to are dates, YYYY-MM-DD";
  if (a > b) return "from is after to";
  if ((b - a) / 86_400_000 + 1 > REPORT_MAX_DAYS) return `a report covers at most ${REPORT_MAX_DAYS} days`;
  return null;
}

const PAID = `status IN ('SUCCESS','SUCCEEDED')`;
// The orders of the range: this merchant's, this mode's, created on those India days.
const RANGE = `vendor = 'KATANA' AND merchant_id = $1 AND livemode = $2
   AND created_at >= ($3::date::timestamp AT TIME ZONE 'Asia/Kolkata')
   AND created_at <  (($4::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;

export async function payinReport(merchant: string, livemode: boolean, from: string, to: string): Promise<PayinReport> {
  const args = [merchant, livemode, from, to];
  const [sum, byDay, byFlow, orders] = await Promise.all([
    rows<Record<string, string>>("vendorGateway", `
      SELECT COUNT(*)::int AS orders, COUNT(*) FILTER (WHERE ${PAID})::int AS paid,
             COALESCE(SUM(amount) FILTER (WHERE ${PAID}), 0)::numeric(18,2)::text AS paid_amount,
             COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
             COUNT(*) FILTER (WHERE status = 'EXPIRED')::int AS expired
        FROM vendor_payin_orders WHERE ${RANGE}`, args),
    rows<Record<string, string>>("vendorGateway", `
      SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS date, COUNT(*)::int AS orders,
             COUNT(*) FILTER (WHERE ${PAID})::int AS paid,
             COALESCE(SUM(amount) FILTER (WHERE ${PAID}), 0)::numeric(18,2)::text AS paid_amount
        FROM vendor_payin_orders WHERE ${RANGE} GROUP BY 1 ORDER BY 1`, args),
    rows<Record<string, string>>("vendorGateway", `
      SELECT COALESCE(channel_type, 'OTHER') AS flow, COUNT(*)::int AS orders,
             COUNT(*) FILTER (WHERE ${PAID})::int AS paid,
             COALESCE(SUM(amount) FILTER (WHERE ${PAID}), 0)::numeric(18,2)::text AS paid_amount
        FROM vendor_payin_orders WHERE ${RANGE} GROUP BY 1 ORDER BY 1`, args),
    rows<Record<string, string | null>>("vendorGateway", `
      SELECT id::text, order_id, amount::numeric(18,2)::text AS amount, currency_code, status, channel_type, rrn,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
             CASE WHEN ${PAID} THEN to_char(COALESCE(katana_ts(meta->'confirmation'->>'at'), updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END AS paid_at
        FROM vendor_payin_orders o WHERE ${RANGE}
       ORDER BY o.created_at, o.id LIMIT ${REPORT_MAX_ORDERS + 1}`, args),
  ]);
  const s = sum[0];
  const total = Number(s.orders), paid = Number(s.paid), failed = Number(s.failed), expired = Number(s.expired);
  const ended = paid + failed + expired;
  return {
    merchant, livemode, from, to,
    summary: {
      orders: total, paid_orders: paid, paid_amount: s.paid_amount,
      failed_orders: failed, expired_orders: expired, pending_orders: total - ended,
      success_rate: ended ? Math.round((paid / ended) * 10_000) / 10_000 : null,
    },
    by_day: byDay.map((d) => ({ date: d.date, orders: Number(d.orders), paid_orders: Number(d.paid), paid_amount: d.paid_amount })),
    by_flow: byFlow.map((f) => ({ flow: f.flow, orders: Number(f.orders), paid_orders: Number(f.paid), paid_amount: f.paid_amount })),
    orders: orders.slice(0, REPORT_MAX_ORDERS).map((o) => ({
      id: o.id!, txnid: o.order_id!, amount: o.amount!, currency: o.currency_code!,
      status: PENDING_STATUSES.has(o.status!) ? "Pending" : callbackStatus(o.status!).STATUS,
      flow: o.channel_type, utr: PAID_STATUSES.has(o.status!) ? o.rrn : null,
      created_at: o.created_at!, paid_at: o.paid_at,
    })),
    truncated: orders.length > REPORT_MAX_ORDERS,
  };
}

const PAID_STATUSES = new Set(["SUCCESS", "SUCCEEDED"]);
const PENDING_STATUSES = new Set(["INITIATED", "PENDING"]);

const COLUMNS: CsvColumn<ReportOrder>[] = [
  { header: "txnid", value: (o) => o.txnid, ref: true },
  { header: "order_id", value: (o) => o.id },
  { header: "amount", value: (o) => o.amount },
  { header: "currency", value: (o) => o.currency },
  { header: "status", value: (o) => o.status },
  { header: "flow", value: (o) => o.flow ?? "" },
  { header: "utr", value: (o) => o.utr ?? "", ref: true },
  { header: "created_at", value: (o) => o.created_at },
  { header: "paid_at", value: (o) => o.paid_at ?? "" },
];

export function reportCsv(r: PayinReport): string {
  return toCsv(COLUMNS, r.orders);
}

/** SHA-256 of a report's content, hex. */
export function reportHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
