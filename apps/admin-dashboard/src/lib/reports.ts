// Report builders for the admin Telegram bot. Each returns a ready-to-send HTML string.
// Queries mirror the existing dashboard endpoints so the numbers match:
//  - collections  → vendor_txn_alerts (captured bank credits) — same filters as vpa-transactions
//  - capture health→ the capture-health cron's stall detector
//  - settlements  → provider_branch_settlements — same status buckets as branch-settlement.ts
//  - leads        → partner_inquiries
//
// "Today" is an explicit Asia/Kolkata calendar day (the app has no shared TZ handling),
// so the boundary is correct regardless of the server's process timezone.

import { rows } from "@/lib/pg";
import { inr, esc } from "@/lib/telegram";
import { IS_COLLECTION } from "@/lib/settlement-credit";
import { RRN_PROVEN_SQL } from "@/lib/credit-verification";

// UTC instant of the most recent IST midnight — comparable to a timestamptz column.
const TODAY_IST = "(now() AT TIME ZONE 'Asia/Kolkata')::date AT TIME ZONE 'Asia/Kolkata'";
// UTC instant of the previous IST midnight (start of "yesterday" in IST).
const YDAY_IST = "((now() AT TIME ZONE 'Asia/Kolkata')::date - 1) AT TIME ZONE 'Asia/Kolkata'";

// Non-terminal settlement statuses = "pending / in-flight" (from branch-settlement.ts).
const SETTLEMENT_TERMINAL =
  "'VERIFIED','RECONCILED','REJECTED','FAILED','CANCELLED','REVERSED','DRAFT','INSUFFICIENT_BALANCE','INVALID_BENEFICIARY'";

// ── Report 1: collections (captured bank credits) for a day window ────────────
// `dateClause` is the SQL created_at filter for the window (today vs yesterday); the rest of
// the filter is the shared IS_COLLECTION predicate, so this report, the provider dashboard,
// the banker portal and the statements all agree on what counts as collected money. It
// excludes second sightings of one payment (DUPLICATE) and settlement legs — the payment app
// paying its held balance into the bank account, which is the same money one leg later. The
// bespoke airtel-settlement exclusion this report used to carry is subsumed by it.
async function collectionsReport(title: string, dateClause: string): Promise<string> {
  // Live credits only: a SIMULATED credit (the test-order simulator) is not collected money.
  const base = `COALESCE(direction,'CREDIT') = 'CREDIT' AND ${IS_COLLECTION} AND livemode = true`;
  try {
    // The reported total is PROVEN money only — credits carrying the UPI network's own 12-digit
    // RRN, or matched to a confirmed order. Credits still without one are a claim the phone
    // made; they are reported on their own line so the headline figure is one you could take to
    // the bank, and the pending amount is still visible rather than silently folded in.
    const [tot] = await rows<{ count: number; gross: number; confirmed: number; proven_n: number; proven: number; pending_n: number; pending: number }>("vendorGateway", `
      SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0)::float AS gross,
             COUNT(*) FILTER (WHERE outcome = 'CONFIRMED')::int AS confirmed,
             COUNT(*) FILTER (WHERE ${RRN_PROVEN_SQL})::int AS proven_n,
             COALESCE(SUM(amount) FILTER (WHERE ${RRN_PROVEN_SQL}),0)::float AS proven,
             COUNT(*) FILTER (WHERE NOT ${RRN_PROVEN_SQL})::int AS pending_n,
             COALESCE(SUM(amount) FILTER (WHERE NOT ${RRN_PROVEN_SQL}),0)::float AS pending
        FROM vendor_txn_alerts WHERE ${base} AND ${dateClause}
    `);
    const perBank = await rows<{ bank: string; n: number; amt: number }>("vendorGateway", `
      SELECT COALESCE(NULLIF(bank,''),'OTHER') AS bank, COUNT(*)::int AS n,
             COALESCE(SUM(amount) FILTER (WHERE ${RRN_PROVEN_SQL}),0)::float AS amt
        FROM vendor_txn_alerts WHERE ${base} AND ${dateClause}
       GROUP BY 1 ORDER BY amt DESC
    `);
    const lines = perBank.map((b) => `   • ${esc(b.bank)}: <b>${inr(b.amt)}</b> (${b.n})`).join("\n");
    return [
      `💰 <b>${title}</b>`,
      `Verified: <b>${inr(tot?.proven)}</b> across <b>${tot?.proven_n ?? 0}</b> payments`,
      (tot?.pending_n ?? 0) > 0
        ? `Awaiting RRN: ${inr(tot?.pending)} (${tot?.pending_n}) — <i>not in the figure above</i>`
        : "",
      `Reconciled: ${tot?.confirmed ?? 0}/${tot?.count ?? 0}`,
      perBank.length ? `\n<b>By app (verified):</b>\n${lines}` : "",
    ].filter(Boolean).join("\n");
  } catch {
    return `💰 <b>${title}</b>\n   ⚠️ unavailable`;
  }
}

export const collectionsToday = () =>
  collectionsReport("Collections today", `created_at >= ${TODAY_IST}`);

export const collectionsYesterday = () =>
  collectionsReport("Collections yesterday", `created_at >= ${YDAY_IST} AND created_at < ${TODAY_IST}`);

// ── Report 2: RRN capture health ──────────────────────────────────────────────
export async function captureHealth(): Promise<string> {
  const WINDOW_MIN = Number(process.env.CAPTURE_WINDOW_MIN ?? 30);
  const STALL_THRESHOLD = Number(process.env.CAPTURE_STALL_THRESHOLD ?? 3);
  const STALL_LAG_MIN = Number(process.env.CAPTURE_STALL_LAG_MIN ?? 20);
  try {
    const stalled = await rows<{ merchant_id: string; recent_missing: number; lag_min: number }>("vendorGateway", `
      WITH rrn_merchants AS (
        SELECT DISTINCT merchant_id FROM vendor_txn_alerts
         WHERE utr ~ '^[0-9]{12}$' AND merchant_id IS NOT NULL AND created_at > now() - interval '7 days'
      ),
      per AS (
        SELECT v.merchant_id,
               max(v.created_at) FILTER (WHERE COALESCE(v.direction,'CREDIT')='CREDIT') AS last_credit,
               max(v.created_at) FILTER (WHERE v.utr ~ '^[0-9]{12}$') AS last_rrn,
               count(*) FILTER (WHERE COALESCE(v.direction,'CREDIT')='CREDIT'
                 AND (v.utr IS NULL OR v.utr !~ '^[0-9]{12}$')
                 AND v.created_at > now() - make_interval(mins => $1))::int AS recent_missing
          FROM vendor_txn_alerts v
         WHERE v.merchant_id IN (SELECT merchant_id FROM rrn_merchants)
           AND v.created_at > now() - interval '24 hours'
         GROUP BY v.merchant_id
      )
      SELECT merchant_id, recent_missing,
             floor(extract(epoch from last_credit - COALESCE(last_rrn, last_credit - interval '999 hours'))/60)::int AS lag_min
        FROM per
       WHERE recent_missing >= $2 AND (last_rrn IS NULL OR last_credit - last_rrn > make_interval(mins => $3))
       ORDER BY recent_missing DESC
    `, [WINDOW_MIN, STALL_THRESHOLD, STALL_LAG_MIN]);

    if (!stalled.length) return `📡 <b>Capture health</b>\n   ✅ All capturing merchants healthy`;
    const lines = stalled.map((s) => `   • <b>${esc(s.merchant_id)}</b>: ${s.recent_missing} credits w/o RRN, lag ${s.lag_min}m`).join("\n");
    return `📡 <b>Capture health</b>\n   ⚠️ ${stalled.length} merchant(s) stalled:\n${lines}`;
  } catch {
    return `📡 <b>Capture health</b>\n   ⚠️ unavailable`;
  }
}

// ── Report 3: settlements (pending + recently settled) ────────────────────────
export async function settlementsSummary(): Promise<string> {
  try {
    const [pending] = await rows<{ n: number; amt: number }>("provider", `
      SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS amt
        FROM provider_branch_settlements
       WHERE status NOT IN (${SETTLEMENT_TERMINAL})
    `);
    const [settledToday] = await rows<{ n: number; amt: number }>("provider", `
      SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS amt
        FROM provider_branch_settlements
       WHERE status IN ('VERIFIED','RECONCILED') AND updated_at >= ${TODAY_IST}
    `);
    const awaiting = await rows<{ status: string; n: number }>("provider", `
      SELECT status, COUNT(*)::int AS n
        FROM provider_branch_settlements
       WHERE status IN ('REQUESTED','UTR_SUBMITTED','REVIEW','ON_HOLD')
       GROUP BY status ORDER BY n DESC
    `);
    const await_lines = awaiting.map((a) => `   • ${esc(a.status)}: ${a.n}`).join("\n");
    return [
      `🏦 <b>Settlements</b>`,
      `Pending (in-flight): <b>${pending?.n ?? 0}</b> — ${inr(pending?.amt)}`,
      `Settled today: <b>${settledToday?.n ?? 0}</b> — ${inr(settledToday?.amt)}`,
      awaiting.length ? `\n<b>Needs action:</b>\n${await_lines}` : "",
    ].filter(Boolean).join("\n");
  } catch {
    return `🏦 <b>Settlements</b>\n   ⚠️ unavailable`;
  }
}

// ── Report 4: partner inquiries (leads) ───────────────────────────────────────
export async function partnerInquiries(): Promise<string> {
  try {
    const byStatus = await rows<{ status: string; n: number }>("merchant", `
      SELECT status, COUNT(*)::int AS n FROM partner_inquiries GROUP BY status
    `);
    const newest = await rows<{ name: string; company: string; partner_type: string; created_at: string }>("merchant", `
      SELECT name, COALESCE(company,'') AS company, COALESCE(partner_type,'') AS partner_type, created_at
        FROM partner_inquiries WHERE status = 'NEW' ORDER BY created_at DESC LIMIT 5
    `);
    const counts = Object.fromEntries(byStatus.map((s) => [s.status, s.n]));
    const total = byStatus.reduce((a, s) => a + s.n, 0);
    const newLines = newest.map((l) =>
      `   • <b>${esc(l.name)}</b>${l.company ? ` (${esc(l.company)})` : ""}${l.partner_type ? ` — ${esc(l.partner_type)}` : ""}`).join("\n");
    return [
      `🤝 <b>Partner inquiries</b>`,
      `New: <b>${counts["NEW"] ?? 0}</b> · Contacted: ${counts["CONTACTED"] ?? 0} · Closed: ${counts["CLOSED"] ?? 0} · Total ${total}`,
      newest.length ? `\n<b>Latest new:</b>\n${newLines}` : "",
    ].filter(Boolean).join("\n");
  } catch {
    return `🤝 <b>Partner inquiries</b>\n   ⚠️ unavailable`;
  }
}

// Combined daily summary — all four, for the scheduled push and /report.
export async function fullReport(): Promise<string> {
  const [c, h, s, p] = await Promise.all([
    collectionsToday(), captureHealth(), settlementsSummary(), partnerInquiries(),
  ]);
  return [`📊 <b>Katana daily report</b>`, c, h, s, p].join("\n\n");
}
