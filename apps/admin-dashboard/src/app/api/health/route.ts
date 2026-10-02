import { NextResponse } from "next/server";
import { rows } from "@/lib/pg";
import { staleJobs } from "@/lib/jobs";

export const dynamic = "force-dynamic";

// GET /api/health          the process is up (no database is asked)
// GET /api/health?deep=1   it can also reach its database, and its scheduled jobs are being
//                          called. 503 when it cannot: point an uptime check at this one.
export async function GET(req: Request) {
  const base = { ok: true, service: "admin-dashboard", ts: new Date().toISOString() };
  if (new URL(req.url).searchParams.get("deep") !== "1") return NextResponse.json(base);

  const db = await rows("vendorGateway", "SELECT 1").then(() => true, () => false);
  const stale = db ? (await staleJobs()).length : 0;
  const ok = db && stale === 0;
  return NextResponse.json({ ...base, ok, db, jobs_stale: stale }, { status: ok ? 200 : 503 });
}
