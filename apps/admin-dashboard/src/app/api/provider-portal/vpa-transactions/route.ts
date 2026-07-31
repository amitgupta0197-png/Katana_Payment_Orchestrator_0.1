// Captured VPA credit transactions (bank/UPI credits landing on the provider's
// branches' settlement VPAs) for the provider dashboard. Sourced from
// vendor_txn_alerts (the Transaction-Intelligence raw credit store) and scoped by
// the settlement VPAs of the provider's mapped branches.
//   PROVIDER only (middleware restricts /api/provider-portal/* to PROVIDER).
//   Returns the newest 200 rows; totals are computed over the WHOLE scope in SQL,
//   not just the returned rows.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

interface Totals { count: number; gross: number; confirmed: number; unmatched: number; missing_rrn: number }

interface Alert {
  id: string; source: string; bank: string | null; amount: number; utr: string | null;
  order_ref: string | null; payer_vpa: string | null; payee_vpa: string | null; narration: string | null;
  matched_order_ref: string | null; outcome: string; match_confidence: number;
  event_time: string | null; created_at: string;
}

export async function GET(req: Request) {
  const g = await gateOrResponse(["PROVIDER", "SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  try {
    const scoped = s.persona === "PROVIDER";
    const codes = await resolveProviderMerchants(s);

    // Optional date-range filter (?from=&to=, ISO timestamps). Applies to the credit
    // totals AND the list, so "Gross received" and the rows reflect the chosen window.
    const url = new URL(req.url);
    const parseTs = (v: string | null): string | null => {
      if (!v) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    };
    const from = parseTs(url.searchParams.get("from"));
    const to = parseTs(url.searchParams.get("to"));

    if (scoped && !codes.length) return NextResponse.json({ vpas: [], totals: empty(), recent: [], captureBlind: [], range: { from, to } });

    // Settlement VPAs of the provider's branches — the accounts these credits land on.
    const vpaRows = scoped
      ? await rows<{ vpa: string }>("merchant", `
          SELECT DISTINCT poolpay->>'settlement_vpa' AS vpa FROM merchant_payment_config
           WHERE merchant_code = ANY($1::text[]) AND COALESCE(poolpay->>'settlement_vpa','') <> ''`, [codes]).catch(() => [])
      : [];
    const vpas = vpaRows.map((r) => r.vpa).filter(Boolean);
    // Scope to the provider's branches by merchant tag (the inbox/device that captured
    // the credit is merchant-tagged). The settlement-VPA match is a FALLBACK for
    // untagged alerts only — a tagged alert belongs to the tagged branch, full stop.
    // Matching tagged alerts by VPA leaked credits across providers whenever two
    // branches shared a settlement VPA (e.g. TEST BRANCH vs K-001).
    const scope = scoped
      ? `(merchant_id = ANY($1::text[])
          OR (COALESCE(merchant_id,'') = '' AND payee_vpa = ANY($2::text[])))`
      : "direction = 'CREDIT'";
    const args: unknown[] = scoped ? [codes, vpas.length ? vpas : ["__none__"]] : [];
    // Append the date-range params (indices follow whatever scope args exist).
    const dateClauses: string[] = [];
    if (from) { args.push(from); dateClauses.push(`created_at >= $${args.length}`); }
    if (to) { args.push(to); dateClauses.push(`created_at <= $${args.length}`); }
    const dateWhere = dateClauses.length ? ` AND ${dateClauses.join(" AND ")}` : "";
    // Hide Airtel settlement rows (15-digit ref, tagged 'airtel-settlement') — each Airtel
    // payment also has a 12-digit UPI-RRN row, so showing the settlement double-lists it.
    // DUPLICATE rows are hidden too: they're re-captures of a payment already listed
    // (agent restart re-uploads), kept in the ledger for forensics only.
    const where = `WHERE ${scope} AND outcome <> 'DUPLICATE'
       AND NOT (bank = 'AIRTEL' AND COALESCE(raw,'') LIKE '%airtel-settlement%')${dateWhere}`;

    // Whole-scope totals. "Missing RRN" = no 12-digit UPI reference yet, past a short
    // grace window (a just-arrived email's screen-reader RRN is seconds behind).
    const totals = (await rows<Totals>("vendorGateway", `
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(amount),0)::float AS gross,
             COUNT(*) FILTER (WHERE outcome = 'CONFIRMED')::int AS confirmed,
             COUNT(*) FILTER (WHERE outcome IN ('UNMATCHED','AMBIGUOUS'))::int AS unmatched,
             COUNT(*) FILTER (WHERE (utr IS NULL OR utr !~ '^[0-9]{12}$')
                                AND created_at < now() - interval '5 minutes')::int AS missing_rrn
        FROM vendor_txn_alerts ${where}
    `, args).catch(() => []))[0] ?? { count: 0, gross: 0, confirmed: 0, unmatched: 0, missing_rrn: 0 };

    // Capture-device health: a branch is "capture-blind" when it has recent no-RRN email
    // credits (RRN only reachable on-device) but NO live agent to backfill them — so those
    // RRNs are silently going uncaptured. Only meaningful for a scoped provider view.
    const captureBlind = scoped
      ? await rows<{ merchant_id: string; missing: number; last_heartbeat: string | null }>("vendorGateway", `
          SELECT m.merchant_id, m.missing, dv.last_heartbeat
            FROM (
              SELECT merchant_id, COUNT(*)::int AS missing
                FROM vendor_txn_alerts
               WHERE merchant_id = ANY($1::text[]) AND source = 'EMAIL' AND direction = 'CREDIT'
                 AND (utr IS NULL OR utr !~ '^[0-9]{12}$')
                 AND created_at > now() - interval '24 hours'
               GROUP BY merchant_id
            ) m
            LEFT JOIN (
              SELECT merchant_id, max(last_heartbeat) AS last_heartbeat
                FROM vendor_devices WHERE COALESCE(agent_enabled, true) GROUP BY merchant_id
            ) dv ON dv.merchant_id = m.merchant_id
           WHERE m.missing > 0
             AND (dv.last_heartbeat IS NULL OR dv.last_heartbeat < now() - interval '30 minutes')
           ORDER BY m.missing DESC`, [codes]).catch(() => [])
      : [];

    // Newest credits for the dashboard list (same scope + Airtel/DUPLICATE filtering
    // as the totals, so the rows and the tiles never disagree).
    const recent = await rows<Alert>("vendorGateway", `
      SELECT id::text, source, bank, amount::float AS amount, utr, order_ref, payer_vpa, payee_vpa, narration,
             matched_order_ref, outcome, match_confidence, event_time, created_at
        FROM vendor_txn_alerts ${where}
       ORDER BY created_at DESC LIMIT 200
    `, args).catch(() => []);

    return NextResponse.json({
      vpas,
      totals: {
        count: totals.count, gross: totals.gross, confirmed: totals.confirmed,
        unmatched: totals.unmatched, missingRrn: totals.missing_rrn,
      },
      recent,
      captureBlind,
      range: { from, to },
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

function empty() { return { count: 0, gross: 0, confirmed: 0, unmatched: 0, missingRrn: 0 }; }
