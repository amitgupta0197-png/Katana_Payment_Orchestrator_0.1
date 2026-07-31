// POST /api/v1/cron/capture-health — watchdog for the on-device RRN capture pipeline.
//
// The 12-digit UPI RRN can only be read off the Paytm Business screen by the on-device
// agent (bank/UPI emails don't carry it). If the capture phone locks, Paytm gets
// backgrounded, or the accessibility service loses its binding, RRNs silently stop
// arriving while credits keep landing (via email) — reconciliation quietly rots.
//
// This job turns that silent failure into a visible dashboard incident: it looks for
// credits that landed but never got a 12-digit RRN within a grace window, scoped to
// merchants that DO normally capture RRNs (so email-only merchants never false-alarm).
// Deduped via a fixed sentinel target so a sustained stall raises one incident, and it
// auto-resolves once the backlog clears. Guarded by x-cron-key like the other crons.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { openIncidentIfMissing, transitionIncident } from "@/lib/incidents";

export const dynamic = "force-dynamic";

// Look at credits from the last this-many minutes when judging "is capture live now".
const WINDOW_MIN = Number(process.env.CAPTURE_WINDOW_MIN ?? 30);
// This many recent credits missing an RRN => capture is falling behind.
const STALL_THRESHOLD = Number(process.env.CAPTURE_STALL_THRESHOLD ?? 3);
// Capture is "stalled" only if the newest RRN lags the newest credit by more than this,
// i.e. credits keep arriving but no RRN has been read for a while. This distinguishes a
// dead capture phone from a merchant's normal historical backlog of un-RRN'd credits.
const STALL_LAG_MIN = Number(process.env.CAPTURE_STALL_LAG_MIN ?? 20);
// Fixed dedup bucket so our incidents never collide with other recon_sla incidents.
const SENTINEL = "00000000-0000-0000-0000-0000000ca97e";

interface Stalled { merchant_id: string; recent_missing: number; lag_min: number }

export async function POST(req: Request) {
  const key = process.env.FIFO_CRON_KEY;
  if (!key) return NextResponse.json({ error: "cron disabled (FIFO_CRON_KEY unset)" }, { status: 503 });
  if (req.headers.get("x-cron-key") !== key) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  try {
    // Only merchants proven to capture RRNs (>=1 in the last 7d) are held to the SLA;
    // an email-only merchant that never gets RRNs must not trip this.
    //
    // Stalled = credits are still arriving (>=threshold recent ones missing an RRN in the
    // last WINDOW_MIN) AND the newest RRN we captured lags the newest credit by more than
    // STALL_LAG_MIN. That combination means the on-device capture has actively stopped —
    // as opposed to a merchant who simply has a long tail of historically un-RRN'd credits.
    const stalled = await rows<Stalled>("vendorGateway", `
      WITH rrn_merchants AS (
        SELECT DISTINCT merchant_id FROM vendor_txn_alerts
         WHERE utr ~ '^[0-9]{12}$' AND merchant_id IS NOT NULL
           AND created_at > now() - interval '7 days'
      ),
      per AS (
        SELECT v.merchant_id,
               max(v.created_at) FILTER (WHERE COALESCE(v.direction,'CREDIT')='CREDIT') AS last_credit,
               max(v.created_at) FILTER (WHERE v.utr ~ '^[0-9]{12}$')                    AS last_rrn,
               count(*) FILTER (
                 WHERE COALESCE(v.direction,'CREDIT')='CREDIT'
                   AND (v.utr IS NULL OR v.utr !~ '^[0-9]{12}$')
                   AND v.created_at > now() - make_interval(mins => $1)
               )::int AS recent_missing
          FROM vendor_txn_alerts v
         WHERE v.merchant_id IN (SELECT merchant_id FROM rrn_merchants)
           AND v.created_at > now() - interval '24 hours'
         GROUP BY v.merchant_id
      )
      SELECT merchant_id, recent_missing,
             floor(extract(epoch from last_credit - COALESCE(last_rrn, last_credit - interval '999 hours')) / 60)::int AS lag_min
        FROM per
       WHERE recent_missing >= $2
         AND (last_rrn IS NULL OR last_credit - last_rrn > make_interval(mins => $3))
       ORDER BY recent_missing DESC
    `, [WINDOW_MIN, STALL_THRESHOLD, STALL_LAG_MIN]).catch(() => [] as Stalled[]);

    let incident: { incident_id: string; created: boolean } | null = null;
    let resolved = 0;

    if (stalled.length) {
      const detail = stalled
        .map((s) => `${s.merchant_id}: ${s.recent_missing} recent credits without RRN, no RRN for ${s.lag_min}m`)
        .join("; ");
      incident = await openIncidentIfMissing({
        severity: "SEV3",
        source: "recon_sla",
        title: `RRN capture stalled — ${stalled.length} merchant(s)`,
        summary: `On-device RRN capture appears stalled. ${detail}. Check the capture phone: Paytm Business open on the payments list, and the Katana Agent accessibility service ON.`,
        related_target: SENTINEL,
        related_entities: { merchants: stalled, window_min: WINDOW_MIN, threshold: STALL_THRESHOLD, stall_lag_min: STALL_LAG_MIN },
        openedBy: "cron@capture-health",
      });
    } else {
      // Backlog cleared — resolve any capture incident we previously opened.
      const open = await rows<{ incident_id: string }>("audit", `
        SELECT incident_id::text FROM incidents
         WHERE source='recon_sla' AND related_target = $1::uuid
           AND status IN ('OPEN','INVESTIGATING','MITIGATING')
      `, [SENTINEL]).catch(() => []);
      for (const o of open) {
        await transitionIncident({
          incidentId: o.incident_id, to: "RESOLVED",
          actorEmail: "cron@capture-health", notes: "RRN capture backlog cleared",
        }).catch(() => {});
        resolved++;
      }
    }

    return NextResponse.json({
      ok: true, checked_at: new Date().toISOString(),
      window_min: WINDOW_MIN, threshold: STALL_THRESHOLD, stall_lag_min: STALL_LAG_MIN,
      stalled, incident, resolved,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
