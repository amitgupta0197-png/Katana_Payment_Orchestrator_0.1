// Statement queries — the rows behind a downloadable statement, for both checkout
// channels, in one shape.
//
// Server-only (imports `pg`). The period maths, row shape and CSV layout live in
// `statement.ts`, which the client also imports.
//
// Scoping is the caller's job: every portal route resolves its own persona to a list of
// merchant/banker codes and passes it in. `codes: null` means "no restriction" and is
// only ever produced by an admin-gated route.

import { rows } from "./pg";
import { settlementVpasFor } from "./settlement-vpa";
import type { StatementChannel, StatementRange, StatementRow } from "./statement";

export interface StatementQuery {
  channel: StatementChannel;
  range: StatementRange;
  /** Merchant/banker codes in scope. `null` = unrestricted (admin only). */
  codes: string[] | null;
}

const MAX_ROWS = 50000;

/**
 * "₹1,234.50" → 1234.5. The GPay detail screen is read off a phone, so these arrive as
 * display strings; anything unparseable returns null so the caller can fall back to the
 * amount we banked rather than writing a 0 into a money column.
 */
function parseMoney(v: string | null): number | null {
  if (!v) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Merchant-hosted checkout: API-generated orders, both the direct and vendor rails. */
async function checkoutRows(q: StatementQuery): Promise<StatementRow[]> {
  const args: unknown[] = [q.range.from.toISOString(), q.range.to.toISOString()];
  const scope = q.codes ? ` AND o.merchant_id = ANY($${args.push(q.codes)}::text[])` : "";

  interface R {
    merchant_id: string | null; party: string | null; paid_via: string | null; type: string | null;
    created_at: string; txn_id: string | null; amount: number; fee: number;
    settlement_amount: number | null; status: string | null; updated_at: string | null;
    notes: string | null; rrn: string | null; order_id: string | null;
  }
  const orders = await rows<R>("checkout", `
    SELECT o.merchant_id,
           COALESCE(NULLIF(d.customer_name,''), NULLIF(o.customer_email,''), NULLIF(d.vpa,'')) AS party,
           COALESCE(NULLIF(o.selected_rail,''), NULLIF(d.provider,''), 'DIRECT')               AS paid_via,
           COALESCE(NULLIF(d.payment_type,''), NULLIF(o.method,''), '')                        AS type,
           o.created_at,
           COALESCE(NULLIF(d.provider_payment_id,''), NULLIF(o.txn_id,''))                     AS txn_id,
           o.amount::float                                                                     AS amount,
           (COALESCE(d.gateway_fee,0) + COALESCE(d.gateway_tax,0))::float                      AS fee,
           d.settlement_amount::float                                                          AS settlement_amount,
           o.status,
           COALESCE(d.updated_at, d.captured_at)::text                                         AS updated_at,
           -- client_ref is whatever free text the merchant sent with the order ("Test order",
           -- a customer name, a description) — it belongs in Notes, not in Order ID, which
           -- has to stay a stable identifier that can be looked up.
           COALESCE(NULLIF(d.error_message,''), NULLIF(o.client_ref,''))                       AS notes,
           NULLIF(d.bank_ref_num,'')                                                           AS rrn,
           o.id::text                                                                          AS order_id
      FROM checkout_orders o
      LEFT JOIN payment_details d ON d.order_id = o.id
     WHERE o.created_at >= $1::timestamptz AND o.created_at < $2::timestamptz${scope}
     ORDER BY o.created_at DESC LIMIT ${MAX_ROWS}
  `, args).catch(() => []);

  const payinArgs: unknown[] = [q.range.from.toISOString(), q.range.to.toISOString()];
  const payinScope = q.codes ? ` AND merchant_id = ANY($${payinArgs.push(q.codes)}::text[])` : "";
  interface P {
    merchant_id: string | null; party: string | null; paid_via: string | null; type: string | null;
    created_at: string; txn_id: string | null; amount: number; status: string | null;
    updated_at: string | null; rrn: string | null; order_id: string | null;
  }
  const payin = await rows<P>("vendorGateway", `
    SELECT merchant_id, NULLIF(customer_vpa,'') AS party, vendor AS paid_via,
           COALESCE(NULLIF(channel,''), 'UPI')  AS type,
           created_at, COALESCE(NULLIF(vendor_txn_id,''), order_id) AS txn_id,
           amount::float AS amount, status, updated_at::text AS updated_at,
           NULLIF(rrn,'') AS rrn, order_id
      FROM vendor_payin_orders
     WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz${payinScope}
     ORDER BY created_at DESC LIMIT ${MAX_ROWS}
  `, payinArgs).catch(() => []);

  return [
    ...orders.map((r): StatementRow => {
      // settlement_amount is what the gateway says actually settles; only when it is absent
      // do we derive net from the fee, so the file never contradicts the gateway.
      const fee = Number(r.fee || 0);
      const amount = Number(r.amount || 0);
      return {
        channel: "CHECKOUT", party: r.party, paid_via: r.paid_via, type: r.type,
        created_at: r.created_at, txn_id: r.txn_id, amount, fee,
        net: r.settlement_amount != null ? Number(r.settlement_amount) : amount - fee,
        status: r.status, updated_at: r.updated_at, notes: r.notes,
        rrn: r.rrn, banker_code: r.merchant_id, order_id: r.order_id,
      };
    }),
    // The vendor pay-in table carries no fee breakdown, so fee stays 0 and net equals the
    // amount — an honest "not charged here" rather than an invented deduction.
    ...payin.map((r): StatementRow => ({
      channel: "CHECKOUT", party: r.party, paid_via: r.paid_via, type: r.type,
      created_at: r.created_at, txn_id: r.txn_id, amount: Number(r.amount || 0),
      fee: 0, net: Number(r.amount || 0), status: r.status, updated_at: r.updated_at,
      notes: null, rrn: r.rrn, banker_code: r.merchant_id, order_id: r.order_id,
    })),
  ];
}

interface AlertRow {
  merchant_id: string | null; source: string | null; bank: string | null; amount: number;
  utr: string | null; payer_vpa: string | null; payer_name: string | null; narration: string | null;
  order_ref: string | null; matched_order_ref: string | null; outcome: string | null;
  event_time: string | null; created_at: string;
  d_paid_via?: string | null; d_method?: string | null; d_gtxn?: string | null;
  d_utxn?: string | null; d_paid?: string | null; d_net?: string | null;
}

/**
 * Gateway-hosted checkout: UPI credits captured on the settlement VPAs.
 *
 * The `details` jsonb (migration 0016) holds what the GPay detail screen said — the Google
 * transaction id, "Customer paid" and "Amount you get". Where it is present the statement
 * reports the payer's real fee; where it is absent (older rows, other sources) the column
 * is 0.00 and net equals the credit. A database that has not had 0016 applied has no such
 * column at all, so the query is retried without it rather than failing the download.
 */
async function vpaRows(q: StatementQuery): Promise<StatementRow[]> {
  const args: unknown[] = [q.range.from.toISOString(), q.range.to.toISOString()];
  let scope = "";
  if (q.codes) {
    // Same segregation rule as the provider dashboard: the banker code the agent stamped on
    // the credit decides ownership. payee_vpa is a fallback ONLY for credits carrying no
    // code — two bankers can share a settlement VPA, so matching on it alone would pull one
    // banker's money into another's statement.
    const codesParam = args.push(q.codes);
    const vpas = await settlementVpasFor(q.codes);
    const vpaParam = args.push(vpas.length ? vpas : ["__none__"]);
    scope = ` AND (merchant_id = ANY($${codesParam}::text[])`
          + ` OR (merchant_id IS NULL AND payee_vpa = ANY($${vpaParam}::text[])))`;
  }

  // DUPLICATE rows are the same payment seen twice (a push and the on-device screen read);
  // including them would double the statement total.
  const where = `WHERE direction = 'CREDIT' AND COALESCE(outcome,'') <> 'DUPLICATE'
                   AND COALESCE(event_time, created_at) >= $1::timestamptz
                   AND COALESCE(event_time, created_at) <  $2::timestamptz${scope}`;
  const base = `
    SELECT merchant_id, source, bank, COALESCE(amount,0)::float AS amount, utr, payer_vpa,
           payer_name, narration, order_ref, matched_order_ref, outcome,
           event_time::text AS event_time, created_at::text AS created_at`;
  const tail = `
      FROM vendor_txn_alerts ${where}
     ORDER BY COALESCE(event_time, created_at) DESC LIMIT ${MAX_ROWS}`;

  const withDetails = `${base},
           details->>'paid_via'              AS d_paid_via,
           details->>'payment_method'        AS d_method,
           details->>'google_transaction_id' AS d_gtxn,
           details->>'upi_transaction_id'    AS d_utxn,
           details->>'customer_paid'         AS d_paid,
           details->>'amount_you_get'        AS d_net${tail}`;

  const alerts = await rows<AlertRow>("vendorGateway", withDetails, args)
    .catch(() => rows<AlertRow>("vendorGateway", base + tail, args).catch(() => []));

  return alerts.map((r): StatementRow => {
    const banked = Number(r.amount || 0);
    const paid = parseMoney(r.d_paid ?? null);
    const got = parseMoney(r.d_net ?? null);
    const amount = paid ?? banked;
    const net = got ?? banked;
    return {
      channel: "VPA",
      party: r.payer_name || r.payer_vpa,
      paid_via: r.d_paid_via || r.source || r.bank,
      type: r.d_method || "UPI",
      created_at: r.event_time || r.created_at,
      txn_id: r.d_gtxn || r.d_utxn || r.utr,
      amount,
      fee: paid != null && got != null ? Math.max(0, paid - got) : 0,
      net: paid != null && got != null ? got : net,
      status: r.outcome,
      updated_at: r.created_at,
      notes: r.narration,
      rrn: r.utr,
      banker_code: r.merchant_id,
      order_id: r.matched_order_ref || r.order_ref,
    };
  });
}

/** Statement rows for the requested channel, newest first. */
export async function fetchStatementRows(q: StatementQuery): Promise<StatementRow[]> {
  // A scoped caller with no codes owns nothing — return empty rather than querying
  // unscoped, which would hand it the whole tenant.
  if (q.codes && !q.codes.length) return [];

  const parts = await Promise.all([
    q.channel === "VPA" ? Promise.resolve([]) : checkoutRows(q),
    q.channel === "CHECKOUT" ? Promise.resolve([]) : vpaRows(q),
  ]);
  return parts.flat().sort(
    (a, b) => +new Date(b.created_at ?? 0) - +new Date(a.created_at ?? 0),
  );
}
