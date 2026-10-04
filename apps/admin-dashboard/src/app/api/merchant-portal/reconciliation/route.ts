// GET /api/merchant-portal/reconciliation — the evidence chain behind each Katana Pay pay-in
// for the provider's bankers: order → gateway result → bank evidence → settlement, reconciled
// INSIDE each pay-in channel (lib/payin-recon).
//
// SETTLED means the banker has settled the order to the merchant: a verified settlement of the
// order's own channel covers it, or one raised for both channels does (lib/banker-settled).
//
// States: MATCHED, AMOUNT_MISMATCH, STATUS_MISMATCH, MISSING_EXTERNAL, MISSING_INTERNAL, DUPLICATE,
// SETTLEMENT_MISMATCH, MANUAL_REVIEW, plus PENDING / NOT_PAID for orders not decided yet.
// MISSING_INTERNAL rows are money with no order (lib/merchant-credits) and SETTLEMENT_MISMATCH
// rows are bankers that settled more to a channel than it collected; both come back in
// `exceptions`, not in `orders`.
//
// Optional ?from=&to= are IST calendar days, the same window the transactions page takes.
// ?state= narrows the rows (not the totals) to one reconciliation state. ?channel= narrows the
// rows and the headline totals to one pay-in channel; `by_channel` and `accounts` always carry
// every channel, so the consolidated view can show which rail a variance belongs to.
//
// ?format=csv downloads the rows (up to 5,000, and the money with no order) with their channel and
// reconciliation state, under the same filters.
//
// PROVIDER only (middleware restricts /api/merchant-portal/* to PROVIDER persona).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { txnConditions, txnWindowFromUrl } from "@/lib/txn-window";
import { getLivemode } from "@/lib/mode";
import { PAYIN_CHANNELS, payinChannelOf, type PayinChannel } from "@/lib/payin-channel";
import { seesGatewayNames } from "@/lib/merchant-safe";
import { coverageArgs, settlementCovering } from "@/lib/banker-settled";
import { channelAccounts, emptyAccount, reconBaseSql, type ChannelAccount } from "@/lib/channel-accounts";
import { ORDER_RECON_STATES, RECON_STATES, parseReconState, type ReconState } from "@/lib/payin-recon";
import { unlinkedCredits } from "@/lib/merchant-credits";
import { formatAmount } from "@/lib/utils";
import { csvResponse, datedFilename, toCsv } from "@/lib/csv";
import { RECON_LABEL } from "@/lib/payin-recon";

export const dynamic = "force-dynamic";

const ROW_LIMIT = 100;

interface Bucket { count: number; amount: number }
interface TimelineEvent { at: string; title: string; detail: string }

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
    // A provider never sees which gateway took a payment (lib/merchant-safe).
    const named = seesGatewayNames(s.persona);
    if (scoped && !codes.length) return NextResponse.json(emptyResponse());

    const url = new URL(req.url);
    const state = parseReconState(url.searchParams.get("state"));
    const csv = url.searchParams.get("format") === "csv";
    const limit = csv ? 5000 : ROW_LIMIT;

    // The reconciliation state is derived, not a column, so it is never passed as `status`.
    const window = { ...txnWindowFromUrl(url, scoped ? codes : null, await getLivemode()), status: null };
    const extra = ["o.vendor = 'KATANA'", ...(scoped ? [] : ["o.merchant_id IS NOT NULL"])];
    const { where, args } = txnConditions("o.", window, extra, "channel_type");

    // Every channel's accounts for the window; a provider sees its own settlements only.
    const acc = await channelAccounts({ window, providerId: scoped ? s.scope_id ?? null : null, extra: scoped ? [] : ["o.merchant_id IS NOT NULL"] });
    const cover = acc.coverage;
    const byChannel = Object.fromEntries(PAYIN_CHANNELS.map((c) => [c,
      Object.fromEntries(RECON_STATES.map((k) => [k, { count: acc.channels[c].recon[k].count, amount: acc.channels[c].recon[k].amount }]))])) as Record<PayinChannel, Record<ReconState, Bucket>>;
    const shown: ChannelAccount = window.channel ? acc.channels[window.channel] : acc.total;
    const by = Object.fromEntries(RECON_STATES.map((k) => [k, { count: shown.recon[k].count, amount: shown.recon[k].amount }])) as Record<ReconState, Bucket>;

    const coverAt = args.length + 1;
    const withCover = window.livemode ? [...args, ...coverageArgs(cover)] : args;
    const orderState = state && (ORDER_RECON_STATES as readonly string[]).includes(state) ? state : null;
    const list = state && !orderState ? [] : await rows<any>("vendorGateway", `
      ${reconBaseSql(where, window.livemode ? coverAt : undefined)}
      SELECT id::text, order_id, vendor_txn_id, merchant_id, amount, status, channel, channel_type, channel_id, meta,
             created_at, updated_at, settled, cum_ch, cum_rest, by_channel, recon, variance, credit_amount
        FROM base ${orderState ? `WHERE recon = $${withCover.length + 1}` : ""}
       ORDER BY created_at DESC LIMIT ${limit}
    `, orderState ? [...withCover, orderState] : withCover);

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
          + `${meta.gateway?.provider && named ? ` · gateway ${meta.gateway.provider}` : ""}`
          + `${conf.utr ? ` · reference ${conf.utr}` : " · no bank reference stated"}`,
      });
      if (isIso(meta.revived_from_expired?.at)) events.push({
        at: meta.revived_from_expired.at, title: "Revived from expired",
        detail: "A real credit arrived after the order had expired; the order was honoured.",
      });
      if (isIso(meta.revived_from_failed?.at)) events.push({
        at: meta.revived_from_failed.at, title: "Revived from failed",
        detail: "A payment went through after an earlier attempt had failed; the order was honoured.",
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
        at: meta.settlement.at, title: "Paid out to banker",
        detail: "The gateway reported the payment paid out to the banker's receiving account.",
      });
      const paidBy = o.settled === true
        ? settlementCovering(cover, o.merchant_id, { channel: o.channel_type, by_channel: o.by_channel, cum_ch: o.cum_ch, cum_rest: o.cum_rest })
        : null;
      if (paidBy) events.push({
        at: paidBy.at, title: "Settled by banker",
        detail: `Covered by the banker's verified ${paidBy.channel ? `${paidBy.channel} ` : ""}settlement of ${formatAmount(paidBy.amount)}`
          + `${paidBy.utr ? ` · UTR ${paidBy.utr}` : ""}. Settlements are applied to the banker's paid orders oldest first`
          + `${paidBy.channel ? `, inside the channel they were raised for.` : "."}`,
      });
      events.sort((a, b) => a.at.localeCompare(b.at));

      return {
        id: o.id, order_id: o.order_id, txn_id: o.vendor_txn_id ?? null, merchant_id: o.merchant_id ?? null,
        amount: o.amount, status: o.status, gateway: named ? meta.gateway?.provider ?? null : null,
        channel_type: payinChannelOf(o.channel_type), channel_id: named ? o.channel_id ?? null : null,
        recon: o.recon as ReconState, variance: Number(o.variance) || 0,
        credit_amount: o.credit_amount == null ? null : Number(o.credit_amount),
        bank_ref: bankRef, evidence, settled: o.settled === true,
        created_at: new Date(o.created_at).toISOString(), timeline: events,
      };
    });

    // Money with no order, and over-settled bankers: exceptions that are not one order.
    const credits = !state || state === "MISSING_INTERNAL"
      ? (await unlinkedCredits({ ...window, status: "RECEIVED" }, limit)).map((c) => ({
          ref: c.ref, merchant_id: c.merchant_id, amount: c.amount, utr: c.utr, created_at: c.created_at, channel_type: c.channel_type,
        }))
      : [];
    const settlement = acc.settlement_exceptions.filter((x) => !window.channel || x.channel === window.channel);

    if (csv) {
      type R = { kind: string; channel: string; banker: string | null; order: string; txn: string; amount: number; status: string;
                 recon: string; variance: number; bank_ref: string; settled: string; at: string };
      const out: R[] = [
        ...orders.map((o) => ({
          kind: "Pay-in", channel: o.channel_type, banker: o.merchant_id, order: o.order_id, txn: o.txn_id ?? "", amount: o.amount,
          status: o.status, recon: o.recon, variance: o.variance, bank_ref: o.bank_ref ?? "", settled: window.livemode ? (o.settled ? "yes" : "no") : "",
          at: o.created_at,
        })),
        ...(window.channel === "INTENT" ? [] : credits).map((c) => ({
          kind: "Received, no order", channel: c.channel_type, banker: c.merchant_id, order: "", txn: "", amount: c.amount,
          status: "RECEIVED", recon: "MISSING_INTERNAL", variance: c.amount, bank_ref: c.utr ?? "", settled: "", at: c.created_at,
        })),
      ];
      return csvResponse(datedFilename("reconciliation"), toCsv<R>([
        { header: "Type", value: (r) => r.kind },
        { header: "Channel", value: (r) => r.channel },
        { header: "Banker", value: (r) => r.banker ?? "" },
        { header: "Merchant order", value: (r) => r.order },
        { header: "Katana txn", value: (r) => r.txn },
        { header: "Amount", value: (r) => r.amount },
        { header: "Status", value: (r) => r.status },
        { header: "Reconciliation", value: (r) => r.recon },
        { header: "Reconciliation (words)", value: (r) => RECON_LABEL[r.recon as ReconState] ?? r.recon },
        { header: "Variance", value: (r) => r.variance },
        { header: "Bank reference (UTR)", value: (r) => r.bank_ref, ref: true },
        { header: "Settled", value: (r) => r.settled },
        { header: "Time", value: (r) => r.at },
      ], out));
    }

    const paidCount = shown.paid.count, paidAmount = shown.paid.amount;
    const evidenced = by.MATCHED;
    return NextResponse.json({
      stages: [
        { key: "order",   count: ORDER_RECON_STATES.reduce((a, k) => a + by[k].count, 0), amount: Math.round(ORDER_RECON_STATES.reduce((a, k) => a + by[k].amount, 0) * 100) / 100 },
        { key: "gateway", count: paidCount, amount: paidAmount },
        { key: "credit",  ...evidenced },
        { key: "settled", count: null, amount: shown.settled ?? 0 },
      ],
      states: by,
      by_channel: byChannel,
      accounts: { channels: acc.channels, total: acc.total },
      panel: {
        expected: paidAmount,
        observed: evidenced.amount,
        matched: evidenced.count,
        unmatched: by.MISSING_EXTERNAL.count + by.MISSING_INTERNAL.count + by.STATUS_MISMATCH.count + by.AMOUNT_MISMATCH.count,
        duplicates: by.DUPLICATE.count,
        callbacks_missing: shown.callbacks_missing,
        settlement_variance: by.SETTLEMENT_MISMATCH.amount,
        variance: shown.variance,
      },
      exceptions: { missing_internal: credits, settlement },
      channel: window.channel ?? null,
      state,
      livemode: window.livemode,
      orders,
      // True when the window holds more orders than the page shows; totals always cover all of it.
      truncated: orders.length >= ROW_LIMIT,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

function emptyResponse() {
  const zero = { count: 0, amount: 0 };
  const acc = emptyAccount();
  return {
    stages: ["order", "gateway", "credit", "settled"].map((key) => ({ key, ...zero })),
    states: Object.fromEntries(RECON_STATES.map((k) => [k, zero])),
    by_channel: Object.fromEntries(PAYIN_CHANNELS.map((c) => [c, Object.fromEntries(RECON_STATES.map((k) => [k, zero]))])),
    accounts: { channels: Object.fromEntries(PAYIN_CHANNELS.map((c) => [c, acc])), total: acc },
    panel: { expected: 0, observed: 0, matched: 0, unmatched: 0, duplicates: 0, callbacks_missing: 0, settlement_variance: 0, variance: 0 },
    exceptions: { missing_internal: [], settlement: [] },
    channel: null, state: null, livemode: true, orders: [], truncated: false,
  };
}
