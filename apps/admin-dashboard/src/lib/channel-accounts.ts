// A merchant's pay-in accounts, per channel: what was collected, what it cost, what was settled,
// what is unexplained, and what was charged back. INTENT and P2P are each worked out from their
// own pay-ins; "All" is the sum of the channels and nothing else, so the consolidated view can
// always be taken apart into the channel that each rupee belongs to.
//
// The sources:
//   pay-ins              vendor_payin_orders (Katana Pay), with each order's reconciliation state
//                        (lib/payin-recon) and whether its banker has settled it (lib/banker-settled)
//   received, no order   money on a banker's UPI ID that no order accounts for (lib/merchant-credits):
//                        P2P, counted in gross, not in settlement until an order is linked
//   fees                 the merchant's rate card per channel (lib/channel-fees)
//   chargebacks          payin_chargebacks, by the day they were received (lib/chargebacks-store)
//
// Dates are IST calendar days (lib/txn-window). Settlement is live money only: in test mode the
// settled / unsettled figures are null.

import { rows } from "@/lib/pg";
import { txnConditions, type TxnWindow } from "@/lib/txn-window";
import { PAYIN_CHANNELS, payinChannelOf, type PayinChannel } from "@/lib/payin-channel";
import { RECON_JOINS, RECON_STATE_SQL, RECON_VARIANCE_SQL, CALLBACK_MISSING_SQL, RECON_STATES, type ReconState } from "@/lib/payin-recon";
import { bankerCoverage, coverageArgs, coverageCte, COVERED_SQL, type BankerCoverage } from "@/lib/banker-settled";
import { feesByChannel, type FeeRule } from "@/lib/channel-fees";
import { unlinkedCredits } from "@/lib/merchant-credits";
import { chargebackTotals, emptyCbTotals, type CbTotals } from "@/lib/chargebacks-store";

/**
 * `WITH [cover0, cover,] base AS (…)`: one row per pay-in matching `where` (over `o.`), with its
 * reconciliation state (`recon`), `variance`, the matched credits (`credit_amount`, `credit_utr`),
 * `callback_missing`, and, when `coverAt` is given, `settled` and its queue position.
 */
export function reconBaseSql(where: string, coverAt?: number): string {
  return `
  WITH ${coverAt ? `${coverageCte(coverAt).trim()},` : ""} base AS (
    SELECT o.id, o.order_id, o.vendor_txn_id, o.merchant_id, o.amount::float AS amount, o.status, o.livemode,
           o.channel, o.channel_type, o.channel_id, o.meta, o.created_at, o.updated_at,
           ${RECON_STATE_SQL} AS recon,
           ${RECON_VARIANCE_SQL(`(${RECON_STATE_SQL})`)} AS variance,
           cr.amt AS credit_amount, cr.utr AS credit_utr,
           ${CALLBACK_MISSING_SQL} AS callback_missing,
           ${coverAt ? COVERED_SQL : "false"} AS settled,
           ${coverAt ? "c.cum_ch, c.cum_rest, c.by_channel" : "NULL::float AS cum_ch, NULL::float AS cum_rest, NULL::boolean AS by_channel"}
      FROM vendor_payin_orders o
      ${RECON_JOINS}
      ${coverAt ? "LEFT JOIN cover c ON c.id = o.id" : ""}
      ${where}
  )`;
}

export interface Bucket { count: number; amount: number }
export interface ReconBucket extends Bucket { variance: number }

export interface ChannelAccount {
  gross: number;                // paid pay-ins + money received with no order
  received_no_order: number;    // of which: no order accounts for it
  paid: Bucket;
  pending: Bucket;
  failed: Bucket;               // failed or expired
  success_rate: number | null;  // paid ÷ (paid + failed); pending orders are not decided yet
  fees: number;                 // by the rate card
  fee_rated: boolean;           // a rate card applies to this channel
  chargeback_debits: number;    // net of reversals
  net: number;                  // gross − fees − chargeback debits
  settled: number | null;       // live only
  unsettled: number | null;
  recon: Record<ReconState, ReconBucket>;
  variance: number;
  callbacks_missing: number;
  chargebacks: CbTotals & { ratio: number | null };
}

export interface ChannelAccounts {
  channels: Record<PayinChannel, ChannelAccount>;
  total: ChannelAccount;
  /** Over-settlement per banker and channel, all time (a settlement is not tied to a day). */
  settlement_exceptions: { banker: string; channel: PayinChannel; collected: number; settled: number; excess: number }[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const zeroRecon = () => Object.fromEntries(RECON_STATES.map((s) => [s, { count: 0, amount: 0, variance: 0 }])) as Record<ReconState, ReconBucket>;

export function emptyAccount(): ChannelAccount {
  return {
    gross: 0, received_no_order: 0, paid: { count: 0, amount: 0 }, pending: { count: 0, amount: 0 }, failed: { count: 0, amount: 0 },
    success_rate: null, fees: 0, fee_rated: false, chargeback_debits: 0, net: 0, settled: null, unsettled: null,
    recon: zeroRecon(), variance: 0, callbacks_missing: 0, chargebacks: { ...emptyCbTotals(), ratio: null },
  };
}

/** "All": every figure is the sum of the channels'. Rates are recomputed from the sums. */
export function sumAccounts(list: ChannelAccount[]): ChannelAccount {
  const t = emptyAccount();
  for (const a of list) {
    t.gross += a.gross; t.received_no_order += a.received_no_order;
    for (const k of ["paid", "pending", "failed"] as const) { t[k].count += a[k].count; t[k].amount += a[k].amount; }
    t.fees += a.fees; t.fee_rated ||= a.fee_rated; t.chargeback_debits += a.chargeback_debits; t.net += a.net;
    if (a.settled != null) t.settled = (t.settled ?? 0) + a.settled;
    if (a.unsettled != null) t.unsettled = (t.unsettled ?? 0) + a.unsettled;
    for (const s of RECON_STATES) {
      t.recon[s].count += a.recon[s].count; t.recon[s].amount += a.recon[s].amount; t.recon[s].variance += a.recon[s].variance;
    }
    t.variance += a.variance; t.callbacks_missing += a.callbacks_missing;
    for (const k of ["count", "amount", "debited", "reversed", "net_debited", "pending_debit", "open"] as const) t.chargebacks[k] += a.chargebacks[k];
  }
  return finish(t);
}

function finish(a: ChannelAccount): ChannelAccount {
  for (const k of ["gross", "received_no_order", "fees", "chargeback_debits", "net", "variance"] as const) a[k] = r2(a[k]);
  if (a.settled != null) a.settled = r2(a.settled);
  if (a.unsettled != null) a.unsettled = r2(a.unsettled);
  for (const k of ["paid", "pending", "failed"] as const) a[k].amount = r2(a[k].amount);
  for (const s of RECON_STATES) { a.recon[s].amount = r2(a.recon[s].amount); a.recon[s].variance = r2(a.recon[s].variance); }
  const decided = a.paid.count + a.failed.count;
  a.success_rate = decided ? Math.round((a.paid.count / decided) * 1000) / 10 : null;
  a.chargebacks.ratio = a.paid.count ? Math.round((a.chargebacks.count / a.paid.count) * 10000) / 100 : null;
  for (const k of ["amount", "debited", "reversed", "net_debited", "pending_debit"] as const) a.chargebacks[k] = r2(a.chargebacks[k]);
  return a;
}

export interface AccountsScope {
  window: TxnWindow;
  /** The merchant whose settlements and rate card apply; null = staff over every merchant. */
  providerId: string | null;
  /** Unscoped staff views leave out pay-ins with no banker, as the other merchant views do. */
  extra?: string[];
}

export async function channelAccounts(scope: AccountsScope): Promise<ChannelAccounts & { coverage: BankerCoverage }> {
  const w = scope.window;
  const accounts = Object.fromEntries(PAYIN_CHANNELS.map((c) => [c, emptyAccount()])) as Record<PayinChannel, ChannelAccount>;
  const extra = ["o.vendor = 'KATANA'", ...(scope.extra ?? [])];
  // Every channel is worked out; a ?channel= narrows only what the caller shows.
  const { where, args } = txnConditions("o.", { ...w, channel: null, status: null }, extra);
  const cover = await bankerCoverage(scope.providerId, w.codes);
  const coverAt = args.length + 1;

  const [grouped, paidGroups, credits, cbs, overSettled] = await Promise.all([
    rows<{ channel_type: string; recon: ReconState; status_group: string; n: number; amount: number; variance: number;
           settled_amount: number; callbacks_missing: number }>("vendorGateway", `
      ${reconBaseSql(where, w.livemode ? coverAt : undefined)}
      SELECT channel_type, recon,
             CASE WHEN status IN ('SUCCESS','SUCCEEDED') THEN 'PAID' WHEN status IN ('FAILED','EXPIRED') THEN 'FAILED' ELSE 'PENDING' END AS status_group,
             COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS amount, COALESCE(SUM(variance),0)::float AS variance,
             COALESCE(SUM(amount) FILTER (WHERE settled),0)::float AS settled_amount,
             COUNT(*) FILTER (WHERE callback_missing)::int AS callbacks_missing
        FROM base GROUP BY 1, 2, 3
    `, w.livemode ? [...args, ...coverageArgs(cover)] : args),
    rows<{ banker: string; channel_type: string; day: string; gross: number }>("vendorGateway", `
      SELECT o.merchant_id AS banker, o.channel_type, to_char(o.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
             SUM(o.amount)::float AS gross
        FROM vendor_payin_orders o ${where} AND o.status IN ('SUCCESS','SUCCEEDED') AND o.merchant_id IS NOT NULL
       GROUP BY 1, 2, 3
    `, args),
    unlinkedCredits({ ...w, channel: null, status: "RECEIVED" }),
    chargebackTotals({ codes: w.codes, livemode: w.livemode, from: w.from, to: w.to }),
    w.livemode ? settlementExceptions(cover) : Promise.resolve([]),
  ]);

  for (const g of grouped) {
    const a = accounts[payinChannelOf(g.channel_type)];
    const b = g.status_group === "PAID" ? a.paid : g.status_group === "FAILED" ? a.failed : a.pending;
    b.count += g.n; b.amount += g.amount;
    a.recon[g.recon].count += g.n; a.recon[g.recon].amount += g.amount; a.recon[g.recon].variance += g.variance;
    a.variance += g.variance;
    a.callbacks_missing += g.callbacks_missing;
    if (w.livemode && g.status_group === "PAID") {
      a.settled = (a.settled ?? 0) + g.settled_amount;
      a.unsettled = (a.unsettled ?? 0) + (g.amount - g.settled_amount);
    }
  }
  if (w.livemode) for (const c of PAYIN_CHANNELS) { accounts[c].settled ??= 0; accounts[c].unsettled ??= 0; }

  // Money with no order: a P2P exception, and money collected.
  for (const cr of credits) {
    const a = accounts[cr.channel_type];
    a.received_no_order += cr.amount;
    a.recon.MISSING_INTERNAL.count += 1; a.recon.MISSING_INTERNAL.amount += cr.amount; a.recon.MISSING_INTERNAL.variance += cr.amount;
    a.variance += cr.amount;
  }

  for (const x of overSettled) {
    const a = accounts[x.channel];
    a.recon.SETTLEMENT_MISMATCH.count += 1; a.recon.SETTLEMENT_MISMATCH.amount += x.excess; a.recon.SETTLEMENT_MISMATCH.variance += x.excess;
    a.variance += x.excess;
  }

  // Fees from the rate card, per banker, channel and day.
  const { rules, providerOf } = await feeRulesFor(scope.providerId, [...new Set(paidGroups.map((g) => g.banker))]);
  const fees = feesByChannel(paidGroups.map((g) => ({ banker: cover.bankerOf.get(g.banker) ?? g.banker, channel: payinChannelOf(g.channel_type), day: g.day, gross: g.gross })), rules, providerOf);

  for (const c of PAYIN_CHANNELS) {
    const a = accounts[c];
    a.gross = a.paid.amount + a.received_no_order;
    a.fees = fees.byChannel[c] ?? 0;
    a.fee_rated = fees.rated[c] ?? false;
    const cb = cbs[c];
    if (cb) a.chargebacks = { ...cb, ratio: null };
    a.chargeback_debits = a.chargebacks.net_debited;
    a.net = a.gross - a.fees - a.chargeback_debits;
    finish(a);
  }
  return {
    channels: accounts,
    total: sumAccounts(PAYIN_CHANNELS.map((c) => accounts[c])),
    settlement_exceptions: overSettled,
    coverage: cover,
  };
}

/**
 * A banker that has settled more to a channel than that channel ever collected (live, all time).
 * Settlements with no channel are compared with what the channel settlements left unsettled; an
 * excess there cannot be put on either channel and is reported as UNCLASSIFIED.
 */
async function settlementExceptions(cover: BankerCoverage): Promise<ChannelAccounts["settlement_exceptions"]> {
  if (!cover.chBankers.length && !cover.restBankers.length) return [];
  const paid = await rows<{ merchant_id: string; channel_type: string; total: number }>("vendorGateway", `
    SELECT merchant_id, channel_type, SUM(amount)::float AS total FROM vendor_payin_orders
     WHERE vendor = 'KATANA' AND livemode = true AND status IN ('SUCCESS','SUCCEEDED') AND merchant_id = ANY($1::text[])
     GROUP BY 1, 2`, [cover.keys]);
  const collected = new Map<string, number>();   // banker|channel → paid
  for (const p of paid) {
    const banker = cover.bankerOf.get(p.merchant_id) ?? p.merchant_id;
    const k = `${banker}|${payinChannelOf(p.channel_type)}`;
    collected.set(k, (collected.get(k) ?? 0) + p.total);
  }
  const out: ChannelAccounts["settlement_exceptions"] = [];
  const leftOver = new Map<string, number>();   // banker → paid not covered by its channel settlements
  for (const [k, v] of collected) { const b = k.split("|")[0]; leftOver.set(b, (leftOver.get(b) ?? 0) + v); }
  cover.chBankers.forEach((banker, i) => {
    const channel = payinChannelOf(cover.chChannels[i]);
    const got = collected.get(`${banker}|${channel}`) ?? 0;
    const settled = cover.chTotals[i];
    leftOver.set(banker, (leftOver.get(banker) ?? 0) - Math.min(settled, got));
    if (settled > got + 0.005) out.push({ banker, channel, collected: r2(got), settled: r2(settled), excess: r2(settled - got) });
  });
  cover.restBankers.forEach((banker, i) => {
    const left = Math.max(0, leftOver.get(banker) ?? 0);
    const settled = cover.restTotals[i];
    if (settled > left + 0.005) out.push({ banker, channel: "UNCLASSIFIED", collected: r2(left), settled: r2(settled), excess: r2(settled - left) });
  });
  return out;
}

/** The rate-card rules that can apply to these bankers, and each banker's merchant. */
async function feeRulesFor(providerId: string | null, bankers: string[]): Promise<{ rules: FeeRule[]; providerOf: (b: string) => string | null }> {
  if (!bankers.length) return { rules: [], providerOf: () => providerId };
  // A merchant's own view: one merchant. Staff: look each banker's merchant up.
  const map = new Map<string, string>();
  if (!providerId) {
    const ids = await rows<{ id: string; merchant_code: string }>("merchant",
      `SELECT id::text, merchant_code FROM merchants WHERE merchant_code = ANY($1::text[]) OR id::text = ANY($1::text[])`, [bankers]).catch(() => []);
    const keys = [...new Set([...bankers, ...ids.flatMap((m) => [m.id, m.merchant_code])])];
    const maps = await rows<{ provider_id: string; merchant_id: string }>("provider", `
      SELECT provider_id::text, merchant_id::text FROM provider_merchant_mappings
       WHERE merchant_id::text = ANY($1::text[]) AND status = 'ACTIVE'`, [keys]).catch(() => []);
    const codeOf = new Map(ids.flatMap((m) => [[m.id, m.merchant_code], [m.merchant_code, m.merchant_code]] as [string, string][]));
    for (const m of maps) map.set(codeOf.get(m.merchant_id) ?? m.merchant_id, m.provider_id);
  }
  const providers = providerId ? [providerId] : [...new Set(map.values())];
  const rules = await rows<FeeRule>("provider", `
    SELECT id::text, provider_id::text, merchant_key, channel_type, upline_bps, katana_bps, downline_bps, gst_bps,
           version, effective_from, effective_to
      FROM provider_settlement_rules
     WHERE provider_id IS NULL OR provider_id::text = ANY($1::text[])`, [providers]).catch(() => []);
  return {
    rules: rules.map((r) => ({ ...r, effective_from: new Date(r.effective_from).toISOString(), effective_to: r.effective_to ? new Date(r.effective_to).toISOString() : null })),
    providerOf: (b) => providerId ?? map.get(b) ?? null,
  };
}
