// Flow dashboards: the payout dashboard (/flows/payout). STAFF ONLY, read-only.
// Payouts are fifo_orders with direction = 'PAYOUT' (lib/fifo-payout); approvals wait in
// fifo_approvals (maker-checker); the money a banker can pay out from is its MERCHANT_PAYABLE
// ledger account (merchantPayableMinor in lib/fifo-payout). Approving, rejecting and releasing
// are done on /payouts and the FIFO dashboard, never here.

import { rows } from "@/lib/pg";
import { countBuckets, PAYOUT_MODES, payoutFailureBucket, payoutMode, type PayoutFailureBucket, type PayoutMode } from "@/lib/flow-dashboards";
import { bankerDirectory, bankerState, IST_TODAY, orNone } from "@/lib/flow-dashboards-store";

const n = (v: unknown) => (v == null ? 0 : Number(v) || 0);
const rupees = (minor: unknown) => Math.round(n(minor)) / 100;

export const SENT_STATUSES = ["COMPLETED", "SETTLED"];
export const FAILED_STATUSES = ["FAILED", "REJECTED", "CANCELLED", "REVERSED"];
/** Not yet sent and not failed: still with Katana, an operator or a processor. */
export const OPEN_SQL = `status NOT IN ('COMPLETED','SETTLED','FAILED','REJECTED','CANCELLED','REVERSED','REFUND','DISPUTE')`;
const IN = (xs: string[]) => `(${xs.map((x) => `'${x}'`).join(",")})`;

export interface PayoutQueueRow {
  code: string; id: string | null; name: string; provider_name: string | null; state: ReturnType<typeof bankerState>;
  open: number; open_amount: number; oldest_at: string | null; awaiting_approval: number; on_hold: number;
  sent_today: number; sent_amount_today: number; failed_today: number;
  /** MERCHANT_PAYABLE (what the banker may pay out from) and its reserve, rupees; null in test mode. */
  payable: number | null; reserve: number | null;
  /** payable less what is waiting; negative = the queue is bigger than the funds. */
  headroom: number | null;
}

export interface PayoutDashboard {
  livemode: boolean; banker: string | null; as_of: string;
  kpi: { requests: number; sent: number; pending_approval: number; failed: number; open: number; sent_amount: number; avg_settle_min: number | null };
  by_mode: { day: string; modes: Record<PayoutMode, number> }[];
  failures: { key: PayoutFailureBucket; n: number }[];
  queue: PayoutQueueRow[];
}

export async function payoutDashboard(livemode: boolean, banker: string | null): Promise<PayoutDashboard> {
  const args: unknown[] = [livemode];
  let scope = "";
  if (banker) { args.push(banker); scope = `AND merchant_id = $${args.length}`; }
  const base = `FROM fifo_orders WHERE direction = 'PAYOUT' AND livemode = $1 ${scope}`;

  const [kpi, modes, fails, queue, approvals, dir] = await Promise.all([
    rows<Record<string, string | null>>("fifo", `
      SELECT COUNT(*)::text AS requests,
             COUNT(*) FILTER (WHERE status IN ${IN(SENT_STATUSES)})::text AS sent,
             COUNT(*) FILTER (WHERE status IN ${IN(FAILED_STATUSES)})::text AS failed,
             COUNT(*) FILTER (WHERE ${OPEN_SQL})::text AS open,
             COALESCE(SUM(amount_minor) FILTER (WHERE status IN ${IN(SENT_STATUSES)}), 0)::text AS sent_minor,
             (AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 60.0) FILTER (WHERE status IN ${IN(SENT_STATUSES)} AND completed_at IS NOT NULL))::text AS avg_min
        ${base} AND created_at >= ${IST_TODAY}`, args),
    rows<Record<string, string | null>>("fifo", `
      SELECT ((created_at AT TIME ZONE 'Asia/Kolkata')::date)::text AS day, payout_rail, transfer_rail, settlement_mode,
             COALESCE(SUM(amount_minor), 0)::text AS minor
        ${base} AND status IN ${IN(SENT_STATUSES)} AND created_at >= ${IST_TODAY} - interval '6 days'
       GROUP BY 1, 2, 3, 4 LIMIT 1000`, args),
    rows<Record<string, string | null>>("fifo", `
      SELECT status, left(COALESCE(failure_reason, dispatch_error, provider_status), 160) AS reason, COUNT(*)::text AS n
        ${base} AND status IN ${IN(FAILED_STATUSES)} AND created_at > now() - interval '7 days'
       GROUP BY 1, 2 LIMIT 500`, args),
    rows<Record<string, string | null>>("fifo", `
      SELECT merchant_id AS code,
             COUNT(*) FILTER (WHERE ${OPEN_SQL})::text AS open,
             COALESCE(SUM(amount_minor) FILTER (WHERE ${OPEN_SQL}), 0)::text AS open_minor,
             MIN(created_at) FILTER (WHERE ${OPEN_SQL})::text AS oldest_at,
             COUNT(*) FILTER (WHERE status = 'HOLD')::text AS on_hold,
             COUNT(*) FILTER (WHERE status IN ${IN(SENT_STATUSES)} AND created_at >= ${IST_TODAY})::text AS sent_today,
             COALESCE(SUM(amount_minor) FILTER (WHERE status IN ${IN(SENT_STATUSES)} AND created_at >= ${IST_TODAY}), 0)::text AS sent_minor_today,
             COUNT(*) FILTER (WHERE status IN ${IN(FAILED_STATUSES)} AND created_at >= ${IST_TODAY})::text AS failed_today
        ${base} AND merchant_id IS NOT NULL AND created_at > now() - interval '30 days'
       GROUP BY 1 HAVING COUNT(*) FILTER (WHERE ${OPEN_SQL}) > 0 OR COUNT(*) FILTER (WHERE created_at >= ${IST_TODAY}) > 0
       ORDER BY COUNT(*) FILTER (WHERE ${OPEN_SQL}) DESC LIMIT 500`, args),
    // Maker-checker approvals. Test payouts never join the queue, so test mode has none.
    livemode
      ? orNone(rows<{ code: string; n: string }>("fifo", `
          SELECT merchant_id AS code, COUNT(*)::text AS n FROM fifo_approvals
           WHERE status = 'PENDING' AND action_type LIKE 'PAYOUT%' AND created_at > now() - interval '30 days' ${banker ? "AND merchant_id = $1" : ""}
           GROUP BY 1`, banker ? [banker] : []))
      : Promise.resolve([] as { code: string; n: string }[]),
    bankerDirectory(),
  ]);

  const codes = queue.map((q) => q.code!);
  // The ledger counts live money only.
  const bal = livemode && codes.length ? await orNone(rows<{ code: string; balance: string }>("ledger", `
    SELECT code, SUM(balance_minor)::text AS balance FROM account_balances
     WHERE currency = 'INR' AND code = ANY($1::text[]) GROUP BY code`,
    [codes.flatMap((c) => [`LIABILITIES.MERCHANT_PAYABLE.${c}`, `LIABILITIES.MERCHANT_RESERVE.${c}`])])) : [];
  // account_balances is debits-positive; a liability's balance is the negative of that.
  const liab = new Map(bal.map((b) => [b.code, -rupees(b.balance)]));
  const appr = new Map(approvals.map((a) => [a.code, n(a.n)]));

  const queueRows: PayoutQueueRow[] = queue.map((q) => {
    const info = dir.get(q.code!);
    const openAmount = rupees(q.open_minor);
    const payable = livemode ? liab.get(`LIABILITIES.MERCHANT_PAYABLE.${q.code}`) ?? 0 : null;
    return {
      code: q.code!, id: info?.id ?? null, name: info?.name ?? q.code!, provider_name: info?.provider_name ?? null, state: bankerState(info),
      open: n(q.open), open_amount: openAmount, oldest_at: q.oldest_at ? new Date(q.oldest_at).toISOString() : null,
      awaiting_approval: appr.get(q.code!) ?? 0, on_hold: n(q.on_hold),
      sent_today: n(q.sent_today), sent_amount_today: rupees(q.sent_minor_today), failed_today: n(q.failed_today),
      payable, reserve: livemode ? liab.get(`LIABILITIES.MERCHANT_RESERVE.${q.code}`) ?? 0 : null,
      headroom: payable == null ? null : Math.round((payable - openAmount) * 100) / 100,
    };
  });

  // Seven IST days, oldest first, each with every mode.
  const days: string[] = [];
  const today = new Date(Date.now() + 5.5 * 3600_000);
  for (let i = 6; i >= 0; i--) days.push(new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  const byDay = new Map(days.map((d) => [d, Object.fromEntries(PAYOUT_MODES.map((m) => [m, 0])) as Record<PayoutMode, number>]));
  for (const m of modes) {
    const slot = byDay.get(m.day!);
    if (slot) slot[payoutMode(m.payout_rail, m.transfer_rail, m.settlement_mode)] += rupees(m.minor);
  }

  const k = kpi[0] ?? {};
  return {
    livemode, banker, as_of: new Date().toISOString(),
    kpi: {
      requests: n(k.requests), sent: n(k.sent), failed: n(k.failed), open: n(k.open),
      pending_approval: [...appr.values()].reduce((a, b) => a + b, 0),
      sent_amount: rupees(k.sent_minor), avg_settle_min: k.avg_min != null ? Math.round(Number(k.avg_min) * 10) / 10 : null,
    },
    by_mode: days.map((day) => ({ day, modes: byDay.get(day)! })),
    failures: countBuckets(fails.map((f) => payoutFailureBucket(f.status, f.reason)),
      ["INSUFFICIENT_FUNDS", "BENEFICIARY", "REJECTED", "PROCESSOR", "RETURNED", "OTHER"] as const, fails.map((f) => n(f.n))),
    queue: queueRows,
  };
}
