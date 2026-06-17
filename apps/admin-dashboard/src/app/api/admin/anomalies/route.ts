// GET /api/admin/anomalies — bucket event_stream by (event_type, hour)
// and surface any bucket above a threshold (BRD §14 P10 "alert grouping").

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";
const BURST_THRESHOLD = Number(process.env.ANOMALY_BURST_THRESHOLD ?? 5);

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const windowH = Math.min(Number(url.searchParams.get("window_hours") ?? 6), 48);
  try {
    // Refresh: bucket the last `window_hours` of events and upsert groups.
    await rows("audit", `
      WITH buckets AS (
        SELECT event_type, entity_type,
               date_trunc('hour', created_at) AS bucket_start,
               COUNT(*)::int AS cnt,
               array_agg(event_id::text ORDER BY created_at DESC) AS ids
          FROM event_stream
         WHERE created_at > now() - ($1 || ' hours')::interval
         GROUP BY 1,2,3
        HAVING COUNT(*) >= $2
      )
      INSERT INTO anomaly_groups
        (signal_kind, entity_type, event_type, bucket_start, bucket_end, signal_count, sample_ids, severity)
      SELECT 'event_burst', entity_type, event_type, bucket_start, bucket_start + interval '1 hour',
             cnt, ids[1:5],
             CASE WHEN cnt >= $2 * 4 THEN 'ALERT'
                  WHEN cnt >= $2 * 2 THEN 'WARN'
                  ELSE 'INFO' END
        FROM buckets
      ON CONFLICT (signal_kind, entity_type, event_type, bucket_start) DO UPDATE
        SET signal_count=EXCLUDED.signal_count, sample_ids=EXCLUDED.sample_ids,
            severity=EXCLUDED.severity;
    `, [windowH, BURST_THRESHOLD]).catch(() => null);

    const groups = await rows<any>("audit", `
      SELECT group_id::text, signal_kind, entity_type, event_type,
             bucket_start, bucket_end, signal_count, severity, sample_ids, created_at
        FROM anomaly_groups
       WHERE bucket_start > now() - ($1 || ' hours')::interval
       ORDER BY signal_count DESC, bucket_start DESC LIMIT 100
    `, [windowH]).catch(() => []);
    return NextResponse.json({ groups, threshold: BURST_THRESHOLD });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
