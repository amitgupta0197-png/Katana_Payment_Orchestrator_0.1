// Pay-in compliance monitoring: the scan and the flags. The rules are in lib/payin-compliance.

import { rows } from "@/lib/pg";
import { setAlert } from "@/lib/ops-alert";
import {
  COMPLIANCE_DEFAULTS, evaluateCompliance, type ComplianceConfig, type ComplianceRule,
  type ComplianceSeverity, type MerchantDayStats,
} from "@/lib/payin-compliance";

/** Today's figures (India time) for every banker with a live, paid order today. */
export async function merchantDayStats(c: ComplianceConfig = COMPLIANCE_DEFAULTS): Promise<MerchantDayStats[]> {
  const r = await rows<Record<string, string>>("vendorGateway", `
    WITH t AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d),
    paid AS (
      SELECT merchant_id, amount, created_at, (created_at AT TIME ZONE 'Asia/Kolkata')::date AS d
        FROM vendor_payin_orders
       WHERE vendor = 'KATANA' AND livemode AND merchant_id IS NOT NULL AND status IN ('SUCCESS','SUCCEEDED')
    ),
    near AS (
      SELECT merchant_id, MAX(n) AS n FROM (
        SELECT merchant_id, COUNT(*) OVER (PARTITION BY merchant_id ORDER BY created_at
                 RANGE BETWEEN interval '1 hour' PRECEDING AND CURRENT ROW) AS n
          FROM paid, t WHERE paid.d = t.d AND amount >= $1 AND amount < $2
      ) x GROUP BY 1
    ),
    life AS (
      SELECT merchant_id, SUM(amount) AS amount FROM paid GROUP BY 1
    ),
    first AS (
      SELECT merchant_id, MIN(created_at) AS at FROM vendor_payin_orders
       WHERE vendor = 'KATANA' AND livemode AND merchant_id IS NOT NULL GROUP BY 1
    )
    SELECT p.merchant_id,
           COALESCE(SUM(p.amount) FILTER (WHERE p.d = t.d), 0)::text                    AS day_amount,
           COUNT(*) FILTER (WHERE p.d = t.d)::text                                      AS day_count,
           COUNT(*) FILTER (WHERE p.d = t.d AND p.amount % 1000 = 0)::text              AS round_count,
           COUNT(*) FILTER (WHERE p.d = t.d AND p.amount >= $2)::text                   AS high_count,
           COALESCE(SUM(p.amount) FILTER (WHERE p.d = t.d AND p.amount >= $2), 0)::text AS high_amount,
           COALESCE(SUM(p.amount) FILTER (WHERE p.d < t.d AND p.d >= t.d - 30), 0)::text AS prior_amount,
           COUNT(DISTINCT p.d) FILTER (WHERE p.d < t.d AND p.d >= t.d - 30)::text       AS prior_days,
           COALESCE(n.n, 0)::text                                                       AS near_in_hour,
           (t.d - (f.at AT TIME ZONE 'Asia/Kolkata')::date)::text                       AS age_days,
           l.amount::text                                                               AS lifetime_amount
      FROM paid p CROSS JOIN t
      JOIN first f USING (merchant_id) JOIN life l USING (merchant_id) LEFT JOIN near n USING (merchant_id)
     WHERE p.d >= t.d - 30
     GROUP BY p.merchant_id, t.d, n.n, f.at, l.amount
    HAVING COUNT(*) FILTER (WHERE p.d = t.d) > 0
  `, [c.highValue * c.structuringBand, c.highValue]);
  return r.map((x) => ({
    merchantId: x.merchant_id,
    dayAmount: Number(x.day_amount), dayCount: Number(x.day_count), roundCount: Number(x.round_count),
    highValueCount: Number(x.high_count), highValueAmount: Number(x.high_amount),
    nearThresholdInHour: Number(x.near_in_hour),
    priorAmount: Number(x.prior_amount), priorActiveDays: Number(x.prior_days),
    ageDays: Number(x.age_days), lifetimeAmount: Number(x.lifetime_amount),
  }));
}

export interface ComplianceScanResult { merchants: number; flags: number; new_flags: number; open: number }

/**
 * Check today's orders against the rules and keep the flags. A flag already there for the same
 * banker, rule and day has its detail brought up to date; its review is left alone.
 */
export async function scanPayinCompliance(c: ComplianceConfig = COMPLIANCE_DEFAULTS): Promise<ComplianceScanResult> {
  const stats = await merchantDayStats(c);
  let flags = 0, fresh = 0;
  for (const s of stats) {
    for (const f of evaluateCompliance(s, c)) {
      const r = await rows<{ inserted: boolean }>("vendorGateway", `
        INSERT INTO payin_compliance_flags (merchant_id, rule, flag_date, severity, detail)
        VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Kolkata')::date, $3, $4::jsonb)
        ON CONFLICT (merchant_id, rule, flag_date) DO UPDATE
          SET severity = EXCLUDED.severity, detail = EXCLUDED.detail, last_seen_at = now()
        RETURNING (xmax = 0) AS inserted
      `, [s.merchantId, f.rule, f.severity, JSON.stringify(f.detail)]);
      flags++;
      if (r[0]?.inserted) fresh++;
    }
  }
  const open = (await rows<{ n: number }>("vendorGateway",
    `SELECT COUNT(*)::int AS n FROM payin_compliance_flags WHERE status = 'OPEN' AND severity <> 'INFO'`))[0]?.n ?? 0;
  await setAlert(open > 0, {
    key: "compliance:flags", severity: "WARN", repeatMinutes: 1440,
    title: `${open} compliance flag${open === 1 ? "" : "s"} to review`,
    body: "Transaction patterns found on live pay-ins. Review them under Risk → Pay-in flags.",
  });
  return { merchants: stats.length, flags, new_flags: fresh, open };
}

export interface ComplianceFlagRow {
  id: string; merchant_id: string; rule: ComplianceRule; flag_date: string; severity: ComplianceSeverity;
  detail: Record<string, number>; status: string; first_seen_at: string; last_seen_at: string;
  reviewed_by: string | null; reviewed_at: string | null; review_note: string | null;
}

const COLS = `id::text, merchant_id, rule, flag_date::text, severity, detail, status, first_seen_at, last_seen_at,
              reviewed_by, reviewed_at, review_note`;

export async function listComplianceFlags(f: { status?: string; merchantId?: string; limit?: number } = {}): Promise<ComplianceFlagRow[]> {
  const where: string[] = []; const args: unknown[] = [];
  if (f.status) { args.push(f.status); where.push(`status = $${args.length}`); }
  if (f.merchantId) { args.push(f.merchantId); where.push(`merchant_id = $${args.length}`); }
  return rows<ComplianceFlagRow>("vendorGateway", `
    SELECT ${COLS} FROM payin_compliance_flags f
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY (f.status = 'OPEN') DESC, f.flag_date DESC, f.id DESC LIMIT ${Math.min(f.limit ?? 200, 500)}
  `, args);
}

export type ReviewStatus = "CLEARED" | "ESCALATED" | "REPORTED";

/** Record a person's decision on a flag. Returns the flag before and after, or null when it does not exist. */
export async function reviewComplianceFlag(id: string, status: ReviewStatus, by: string, note: string | null):
  Promise<{ before: ComplianceFlagRow; after: ComplianceFlagRow } | null> {
  const before = (await rows<ComplianceFlagRow>("vendorGateway", `SELECT ${COLS} FROM payin_compliance_flags WHERE id = $1::bigint`, [id]))[0];
  if (!before) return null;
  const after = (await rows<ComplianceFlagRow>("vendorGateway", `
    UPDATE payin_compliance_flags SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4
     WHERE id = $1::bigint RETURNING ${COLS}
  `, [id, status, by, note]))[0];
  return { before, after };
}
