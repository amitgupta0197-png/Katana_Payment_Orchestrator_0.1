// GET /api/merchant-portal/reconciliation — the evidence chain behind each Katana Pay pay-in
// for the provider's bankers: order → gateway result → bank evidence → settlement.
//
// A pay-in is RECONCILED only when two things agree: the order is paid, and there is bank
// evidence for it that Katana did not make up — a UTR/RRN stated by the gateway, ops or the
// payer's proof, or a bank-credit alert matched to the order. `vendor_payin_orders.rrn` is
// deliberately NOT that evidence: an order confirmed without a reference gets a generated one
// (genRrn), so it is always filled on a paid order and proves nothing.
//
// Optional ?from=&to= are IST calendar days, the same window the transactions page takes.
// ?state= narrows the rows (not the totals) to one reconciliation state. ?channel= narrows
// everything to one pay-in channel; `by_channel` always carries the per-channel totals of the
// window, so the consolidated view can show which rail a variance belongs to.
//
// PROVIDER only (middleware restricts /api/merchant-portal/* to PROVIDER persona).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { txnConditions, txnWindowFromUrl } from "@/lib/txn-window";
import { getLivemode } from "@/lib/mode";
import { PAYIN_CHANNELS, payinChannelOf, type PayinChannel } from "@/lib/payin-channel";

export const dynamic = "force-dynamic";

const STATES = ["RECONCILED", "AWAITING_EVIDENCE", "NEEDS_REVIEW", "PENDING", "NOT_PAID"] as const;
type ReconState = (typeof STATES)[number];

const ROW_LIMIT = 100;

interface Bucket { count: number; amount: number }
interface TimelineEvent { at: string; title: string; detail: string }

const PAID = `o.status IN ('SUCCESS','SUCCEEDED')`;

// One row per pay-in with its reconciliation state. The alert join is a single pass over the
// matched credits rather than a lookup per order.
const base = (where: string) => `
  WITH base AS (
    SELECT o.id, o.order_id, o.vendor_txn_id, o.merchant_id, o.amount::float AS amount, o.status,
           o.channel, o.channel_type, o.channel_id, o.meta, o.created_at, o.updated_at,
           COALESCE(o.meta->'settlement'->>'status' = 'SETTLED', false) AS settled,
           CASE
             WHEN ${PAID} AND (COALESCE(o.meta->'confirmation'->>'utr','') <> '' OR a.matched_order_id IS NOT NULL) THEN 'RECONCILED'
             WHEN ${PAID} THEN 'AWAITING_EVIDENCE'
             WHEN o.status IN ('FAILED','EXPIRED') THEN 'NOT_PAID'
             WHEN o.meta->>'hold' = 'true' OR o.meta->>'review' = 'PROOF_SUBMITTED' THEN 'NEEDS_REVIEW'
             ELSE 'PENDING'
           END AS recon
      FROM vendor_payin_orders o
      LEFT JOIN (
        SELECT DISTINCT matched_order_id FROM vendor_txn_alerts
         WHERE outcome = 'CONFIRMED' AND matched_order_id IS NOT NULL
      ) a ON a.matched_order_id = o.id
      ${where}
  )`;

// Who confirmed an order, without printing an operator's email or a device id to a merchant.
function actorLabel(by: unknown): string {
  const s = typeof by === "string" ? by : "";
  if (!s) return "system";
  if (s.includes("@")) return "Katana operations";
  return s.split(":")[0];
}

const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

export async function GET(req: Request) {
  const g = await gateOrResponse(["PROVIDER", "SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;

  try {
    const codes = await resolveProviderMerchants(s);
    const scoped = s.persona === "PROVIDER";
    if (scoped && !codes.length) return NextResponse.json(emptyResponse());

    const url = new URL(req.url);
    const stateParam = url.searchParams.get("state")?.toUpperCase() ?? "";
    const state = (STATES as readonly string[]).includes(stateParam) ? (stateParam as ReconState) : null;

    // The reconciliation state is derived, not a column, so it is never passed as `status`.
    const window = { ...txnWindowFromUrl(url, scoped ? codes : null, await getLivemode()), status: null };
    const extra = ["o.vendor = 'POOLPAY'", ...(scoped ? [] : ["o.merchant_id IS NOT NULL"])];
    const { where, args } = txnConditions("o.", window, extra, "channel_type");

    // Per-channel totals of the whole window, whatever channel is selected.
    const all = txnConditions("o.", { ...window, channel: null }, extra);
    const perChannel = await rows<{ channel_type: string; recon: ReconState; n: number; amount: number }>("vendorGateway", `
      ${base(all.where)}
      SELECT channel_type, recon, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS amount
        FROM base GROUP BY channel_type, recon
    `, all.args);
    const byChannel = Object.fromEntries(PAYIN_CHANNELS.map((c) => [c,
      Object.fromEntries(STATES.map((k) => [k, { count: 0, amount: 0 }]))])) as Record<PayinChannel, Record<ReconState, Bucket>>;
    for (const r of perChannel) byChannel[payinChannelOf(r.channel_type)][r.recon] = { count: r.n, amount: r.amount };

    const agg = await rows<{ recon: ReconState; n: number; amount: number; settled_n: number; settled_amount: number }>("vendorGateway", `
      ${base(where)}
      SELECT recon, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS amount,
             COUNT(*) FILTER (WHERE settled)::int AS settled_n,
             COALESCE(SUM(amount) FILTER (WHERE settled),0)::float AS settled_amount
        FROM base GROUP BY recon
    `, args);

    const by = Object.fromEntries(STATES.map((k) => [k, { count: 0, amount: 0 }])) as Record<ReconState, Bucket>;
    const settled: Bucket = { count: 0, amount: 0 };
    for (const r of agg) {
      by[r.recon] = { count: r.n, amount: r.amount };
      settled.count += r.settled_n; settled.amount += r.settled_amount;
    }
    const sum = (...keys: ReconState[]): Bucket => keys.reduce(
      (a, k) => ({ count: a.count + by[k].count, amount: Math.round((a.amount + by[k].amount) * 100) / 100 }),
      { count: 0, amount: 0 });

    const list = await rows<any>("vendorGateway", `
      ${base(where)}
      SELECT id::text, order_id, vendor_txn_id, merchant_id, amount, status, channel, channel_type, channel_id, meta,
             created_at, updated_at, settled, recon
        FROM base ${state ? `WHERE recon = $${args.length + 1}` : ""}
       ORDER BY created_at DESC LIMIT ${ROW_LIMIT}
    `, state ? [...args, state] : args);

    // The bank-credit alerts matched to the orders on this page — the independent evidence.
    const alerts = list.length ? await rows<any>("vendorGateway", `
      SELECT matched_order_id::text AS order_id, source, bank, utr, amount::float AS amount,
             match_confidence, COALESCE(event_time, created_at) AS seen_at
        FROM vendor_txn_alerts
       WHERE matched_order_id = ANY($1::uuid[]) AND outcome = 'CONFIRMED'
       ORDER BY created_at ASC
    `, [list.map((r) => r.id)]).catch(() => []) : [];
    const alertOf = new Map<string, any>();
    for (const a of alerts) if (!alertOf.has(a.order_id)) alertOf.set(a.order_id, a);

    const orders = list.map((o) => {
      const meta = o.meta ?? {};
      const alert = alertOf.get(o.id) ?? null;
      const conf = meta.confirmation ?? null;
      const bankRef: string | null = (conf?.utr && String(conf.utr).trim()) || alert?.utr || null;
      const evidence = alert ? "BANK_CREDIT" : bankRef ? (conf?.evidence ?? "REFERENCE") : null;

      const events: TimelineEvent[] = [{
        at: new Date(o.created_at).toISOString(), title: "Order created",
        detail: `Merchant order ${o.order_id}${o.channel ? ` · ${o.channel}` : ""} · banker ${o.merchant_id ?? "—"}`,
      }];
      if (isIso(meta.proof?.submitted_at)) events.push({
        at: meta.proof.submitted_at, title: "Payer proof submitted",
        detail: meta.proof.utr ? `Payer stated UTR ${meta.proof.utr}; awaiting review.` : "Screenshot uploaded; awaiting review.",
      });
      if (alert) events.push({
        at: new Date(alert.seen_at).toISOString(), title: "Bank credit observed",
        detail: `${alert.bank ?? alert.source} credit${alert.utr ? ` · ${alert.utr}` : ""} matched to this order (confidence ${alert.match_confidence}).`,
      });
      if (isIso(conf?.at)) events.push({
        at: conf.at, title: o.recon === "NOT_PAID" ? "Marked not paid" : "Payment confirmed",
        detail: `Confirmed by ${actorLabel(conf.by)}${conf.evidence ? ` (${String(conf.evidence).toLowerCase()})` : ""}`
          + `${meta.gateway?.provider ? ` · gateway ${meta.gateway.provider}` : ""}`
          + `${conf.utr ? ` · reference ${conf.utr}` : " · no bank reference stated"}`,
      });
      if (isIso(meta.revived_from_expired?.at)) events.push({
        at: meta.revived_from_expired.at, title: "Revived from expired",
        detail: "A real credit arrived after the order had expired; the order was honoured.",
      });
      if (!conf && (o.status === "FAILED" || o.status === "EXPIRED")) events.push({
        at: new Date(o.updated_at).toISOString(), title: o.status === "EXPIRED" ? "Order expired" : "Payment failed",
        detail: o.status === "EXPIRED" ? "No payment arrived before the order timed out." : "The gateway reported the payment as failed.",
      });
      if (isIso(meta.callback?.sent_at)) events.push({
        at: meta.callback.sent_at, title: "Merchant notified",
        detail: `Signed status callback (${meta.callback.status ?? o.status}) queued to the merchant server.`,
      });
      else if (isIso(meta.callback?.at) && meta.callback?.skipped) events.push({
        at: meta.callback.at, title: "Merchant not notified",
        detail: `No status callback sent: ${meta.callback.skipped}.`,
      });
      if (isIso(meta.settlement?.at)) events.push({
        at: meta.settlement.at, title: "Settled",
        detail: "The gateway reported the payment settled to the receiving account.",
      });
      events.sort((a, b) => a.at.localeCompare(b.at));

      return {
        id: o.id, order_id: o.order_id, txn_id: o.vendor_txn_id ?? null, merchant_id: o.merchant_id ?? null,
        amount: o.amount, status: o.status, gateway: meta.gateway?.provider ?? null,
        channel_type: payinChannelOf(o.channel_type), channel_id: o.channel_id ?? null,
        recon: o.recon as ReconState, bank_ref: bankRef, evidence, settled: o.settled === true,
        created_at: new Date(o.created_at).toISOString(), timeline: events,
      };
    });

    const paid = sum("RECONCILED", "AWAITING_EVIDENCE");
    return NextResponse.json({
      stages: [
        { key: "order",   ...sum(...STATES) },
        { key: "gateway", ...paid },
        { key: "credit",  ...by.RECONCILED },
        { key: "settled", ...settled },
      ],
      states: by,
      by_channel: byChannel,
      channel: window.channel ?? null,
      state,
      orders,
      // True when the window holds more orders than the page shows; totals always cover all of it.
      truncated: orders.length >= ROW_LIMIT,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

function emptyResponse() {
  const zero = { count: 0, amount: 0 };
  return {
    stages: ["order", "gateway", "credit", "settled"].map((key) => ({ key, ...zero })),
    states: Object.fromEntries(STATES.map((k) => [k, zero])),
    by_channel: Object.fromEntries(PAYIN_CHANNELS.map((c) => [c, Object.fromEntries(STATES.map((k) => [k, zero]))])),
    channel: null, state: null, orders: [], truncated: false,
  };
}
