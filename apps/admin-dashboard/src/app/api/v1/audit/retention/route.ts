// GET /api/v1/audit/retention — data-retention policy (BRD §27). The module
// PRESERVES transaction/audit evidence for the configured legal period; nothing
// is auto-deleted before it. Reports the policy + oldest record age so an auditor
// can confirm coverage.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const RETENTION_DAYS = Number(process.env.FIFO_RETENTION_DAYS ?? 2555); // ~7 years

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "COMPLIANCE", "RISK", "FINANCE"]);
  if ("response" in g) return g.response;
  try {
    const o = (await rows<any>("fifo", `
      SELECT MIN(created_at) AS oldest, COUNT(*)::int AS n FROM fifo_orders
    `))[0] ?? { oldest: null, n: 0 };
    const ev = (await rows<any>("fifo", `SELECT COUNT(*)::int AS n FROM fifo_order_events`))[0] ?? { n: 0 };
    return NextResponse.json({
      retention_days: RETENTION_DAYS,
      policy: "append-only; transaction + audit evidence preserved for the configured legal period; no auto-purge before it",
      oldest_record: o.oldest, orders: o.n, audit_events: ev.n,
      auto_purge: false,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
