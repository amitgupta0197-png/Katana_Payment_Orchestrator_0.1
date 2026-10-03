// The portals' Home (GET /api/portal/home): is money coming in, and is anything wrong.
//
//   today       paid orders, waiting / failed / expired counts, money seen on their UPI IDs (live
//               only) and payouts sent, for the mode the portal is in (Test / Live switch)
//   settlement  collected but not yet settled, the settlement in progress, the last one paid
//   attention   things that need a person: money that came in after its order expired or
//               failed, payment messages that did not reach their server, payouts that failed or
//               are on hold, many refused API requests, a paused account
//   setup       the go-live checklist of every banker not live yet, each step with where to do it
//
// Scoped to the session's bankers (lib/portal-scope); rules and wording in lib/portal-home-rules.

import { rows } from "@/lib/pg";
import type { Session } from "@/lib/auth";
import { portalScope } from "@/lib/portal-scope";
import { IS_COLLECTION } from "@/lib/settlement-credit";
import { v2Status } from "@/lib/webhook-v2";
import { activationState } from "@/lib/live-activation";
import { outstandingForBranch } from "@/lib/branch-settlement";
import { providerForMerchant } from "@/lib/provider-integration";
import { portalsEnabled } from "@/lib/support-bot/scope";
import {
  apiErrorItem, blockedItem, lateMoneyItem, payoutItem, requestLiveAction, sortAttention, stepAction, webhookItem,
  type AttentionItem, type PortalBase, type SetupStep,
} from "@/lib/portal-home-rules";

const TODAY_IST = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
const MAX_BANKERS = 30;

export interface HomeData {
  name: string;
  base: PortalBase;
  livemode: boolean;
  bankers: number;
  today: {
    paid: { count: number; amount: number };
    waiting: number; failed: number; expired: number;
    upi_received: { count: number; amount: number } | null;
    payouts_sent: { count: number; amount: number };
  };
  settlement: { waiting: number; in_progress: { count: number; amount: number }; last: { amount: number; at: string } | null } | null;
  attention: AttentionItem[];
  setup: { code: string; name: string; banker_id: string; status: string; ready: boolean; steps: SetupStep[]; request: { label: string; href: string } | null }[];
}

const num = (v: unknown) => Number(v ?? 0) || 0;

export async function homeData(s: Session, livemode: boolean): Promise<HomeData | null> {
  const scope = await portalScope(s);
  if (scope.staff || !scope.codes) return null;
  const codes = scope.codes.slice(0, MAX_BANKERS);
  const base: PortalBase = s.persona === "PROVIDER" ? "/merchant-portal" : "/banker-portal";
  const assistant = portalsEnabled();

  const bankers = codes.length ? await rows<{ id: string; code: string; name: string; blocked: boolean | null }>("merchant", `
    SELECT m.id::text, m.merchant_code AS code, COALESCE(NULLIF(m.brand_name, ''), m.legal_name, m.merchant_code) AS name, c.blocked
      FROM merchants m LEFT JOIN merchant_payment_config c ON c.merchant_code = m.merchant_code
     WHERE m.merchant_code = ANY($1::text[]) ORDER BY 3
  `, [codes]).catch(() => []) : [];
  const empty: HomeData = {
    name: s.scope_label || bankers[0]?.name || "", base, livemode, bankers: bankers.length,
    today: { paid: { count: 0, amount: 0 }, waiting: 0, failed: 0, expired: 0, upi_received: null, payouts_sent: { count: 0, amount: 0 } },
    settlement: null, attention: [], setup: [],
  };
  if (!codes.length) return empty;

  const [orders, upi, payouts, late, hooks, payoutIssues, apiErrs, settlement, setup] = await Promise.all([
    rows<{ status: string; n: number; amount: number }>("vendorGateway", `
      SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::float AS amount FROM vendor_payin_orders
       WHERE vendor = 'KATANA' AND merchant_id = ANY($1::text[]) AND livemode = $2 AND created_at >= ${TODAY_IST}
       GROUP BY status`, [codes, livemode]).catch(() => []),
    livemode ? rows<{ n: number; amount: number }>("vendorGateway", `
      SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::float AS amount FROM vendor_txn_alerts
       WHERE direction = 'CREDIT' AND ${IS_COLLECTION} AND livemode = true AND merchant_id = ANY($1::text[])
         AND COALESCE(event_time, created_at) >= ${TODAY_IST}`, [codes]).catch(() => []) : Promise.resolve([]),
    rows<{ n: number; amount: number }>("fifo", `
      SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_minor), 0)::float / 100 AS amount FROM fifo_orders
       WHERE direction = 'PAYOUT' AND merchant_id = ANY($1::text[]) AND livemode = $2 AND status IN ('COMPLETED', 'SETTLED')
         AND created_at >= ${TODAY_IST}`, [codes, livemode]).catch(() => []),
    // Money that arrived, unlinked, shortly after an order of the same amount expired or failed.
    rows<{ amount: number; utr: string | null; paid_at: string; order_txnid: string; order_status: string }>("vendorGateway", `
      SELECT DISTINCT ON (c.id) c.amount::float AS amount, c.utr, c.t AS paid_at, o.order_id AS order_txnid, o.status AS order_status
        FROM (SELECT id, merchant_id, amount, utr, livemode, COALESCE(event_time, created_at) AS t FROM vendor_txn_alerts
               WHERE direction = 'CREDIT' AND ${IS_COLLECTION} AND outcome IN ('UNMATCHED', 'AMBIGUOUS') AND matched_order_id IS NULL
                 AND merchant_id = ANY($1::text[]) AND livemode = $2 AND COALESCE(event_time, created_at) > now() - interval '7 days') c
        JOIN vendor_payin_orders o ON o.vendor = 'KATANA' AND o.merchant_id = c.merchant_id AND o.amount = c.amount
         AND o.livemode = c.livemode AND o.status IN ('EXPIRED', 'FAILED')
         AND o.created_at BETWEEN c.t - interval '2 hours' AND c.t
       ORDER BY c.id, o.created_at DESC
       LIMIT 5`, [codes, livemode]).catch(() => []),
    rows<{ dead: number; retrying: number }>("notification", `
      SELECT COUNT(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS dead,
             COUNT(*) FILTER (WHERE status = 'PENDING' AND attempts > 0)::int AS retrying
        FROM webhook_outbox
       WHERE merchant_id = ANY($1::text[]) AND NOT COALESCE(is_test, false) AND COALESCE(livemode, true) = $2
         AND created_at > now() - interval '7 days'`, [codes, livemode]).catch(() => []),
    rows<{ held: number; failed: number; returned: number }>("fifo", `
      SELECT COUNT(*) FILTER (WHERE status = 'HOLD')::int AS held,
             COUNT(*) FILTER (WHERE status IN ('FAILED', 'REJECTED', 'CANCELLED'))::int AS failed,
             COUNT(*) FILTER (WHERE status = 'REVERSED')::int AS returned
        FROM fifo_orders
       WHERE direction = 'PAYOUT' AND merchant_id = ANY($1::text[]) AND livemode = $2 AND created_at > now() - interval '2 days'`,
      [codes, livemode]).catch(() => []),
    rows<{ n: number; last_code: string | null }>("audit", `
      SELECT COUNT(*)::int AS n, (ARRAY_AGG(error_code ORDER BY created_at DESC))[1] AS last_code FROM api_request_log
       WHERE merchant_id = ANY($1::text[]) AND http_status >= 400 AND COALESCE(livemode, true) = $2 AND created_at >= ${TODAY_IST}`,
      [codes, livemode]).catch(() => []),
    settlementFor(s, codes, bankers.map((b) => b.id)).catch(() => null),
    Promise.all(bankers.slice(0, 10).map(async (b) => {
      const a = await activationState(b.code).catch(() => null);
      if (!a || a.status === "ACTIVATED") return null;
      return {
        code: b.code, name: b.name, banker_id: b.id, status: a.status, ready: a.ready,
        steps: a.checklist.map((i) => ({ key: i.key, label: i.label, done: i.done, hint: i.hint, ...stepAction(i.key, base, b.id) })),
        request: a.ready && a.status === "NOT_REQUESTED" ? requestLiveAction(base, b.id) : null,
      };
    })),
  ]);

  const by = (st: string) => orders.filter((o) => v2Status(o.status) === st);
  const sum = (xs: { n: number; amount: number }[]) => ({ count: xs.reduce((a, x) => a + num(x.n), 0), amount: xs.reduce((a, x) => a + num(x.amount), 0) });
  const attention: (AttentionItem | null)[] = [
    ...(bankers.some((b) => b.blocked) ? [blockedItem(base)] : []),
    ...late.map((m) => lateMoneyItem({ ...m, paid_at: new Date(m.paid_at).toISOString() }, base)),
    webhookItem(num(hooks[0]?.dead), num(hooks[0]?.retrying), base),
    payoutItem({ held: num(payoutIssues[0]?.held), failed: num(payoutIssues[0]?.failed), returned: num(payoutIssues[0]?.returned) }, base, assistant),
    apiErrorItem(num(apiErrs[0]?.n), apiErrs[0]?.last_code ?? null, base),
  ];

  return {
    ...empty,
    today: {
      paid: sum(by("SUCCESS")),
      waiting: sum(by("PENDING")).count, failed: sum(by("FAILED")).count, expired: sum(by("EXPIRED")).count,
      upi_received: upi[0] && num(upi[0].n) > 0 ? { count: num(upi[0].n), amount: num(upi[0].amount) } : null,
      payouts_sent: { count: num(payouts[0]?.n), amount: num(payouts[0]?.amount) },
    },
    settlement,
    attention: sortAttention(attention.filter((x): x is AttentionItem => !!x)),
    setup: setup.filter((x): x is NonNullable<typeof x> => !!x),
  };
}

/** Collected by the bankers but not yet settled, the one in progress, and the last one paid. */
async function settlementFor(s: Session, codes: string[], ids: string[]): Promise<HomeData["settlement"]> {
  const providerId = s.persona === "PROVIDER" ? s.scope_id : await providerForMerchant(codes[0]);
  if (!providerId) return null;
  const keys = [...codes, ...ids];
  const [owed, progress, last] = await Promise.all([
    Promise.all(codes.map((c) => outstandingForBranch(providerId, c).then((o) => o.outstanding).catch(() => 0))),
    rows<{ n: number; amount: number }>("provider", `
      SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::float AS amount FROM provider_branch_settlements
       WHERE provider_id = $1::uuid AND merchant_key = ANY($2::text[])
         AND status NOT IN ('VERIFIED', 'RECONCILED', 'REJECTED', 'CANCELLED', 'FAILED')`, [providerId, keys]),
    rows<{ amount: number; at: string }>("provider", `
      SELECT amount::float AS amount, COALESCE(verified_at, updated_at) AS at FROM provider_branch_settlements
       WHERE provider_id = $1::uuid AND merchant_key = ANY($2::text[]) AND status IN ('VERIFIED', 'RECONCILED')
       ORDER BY COALESCE(verified_at, updated_at) DESC LIMIT 1`, [providerId, keys]),
  ]);
  return {
    waiting: Math.round(owed.reduce((a, x) => a + x, 0) * 100) / 100,
    in_progress: { count: num(progress[0]?.n), amount: num(progress[0]?.amount) },
    last: last[0] ? { amount: num(last[0].amount), at: new Date(last[0].at).toISOString() } : null,
  };
}
