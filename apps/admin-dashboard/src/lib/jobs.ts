// Scheduled jobs: the shared gate and the heartbeat.
//
// A job is an HTTP route the server's crontab calls with the x-cron-key header. cronGate()
// is the check every such route makes; runJob() records that the job ran (job_heartbeats,
// audit 0006) so a job that has stopped being called can be seen: /api/health?deep=1,
// /api/metrics and the monitor job all read staleJobs().
//
// The heartbeat is best-effort. A job's work is never failed, or skipped, because its
// heartbeat could not be written.

import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { rows } from "@/lib/pg";

/** A 503/403 answer when the caller may not run jobs, else null. */
export function cronGate(req: Request): NextResponse | null {
  const key = process.env.FIFO_CRON_KEY;
  if (!key) return NextResponse.json({ error: "cron disabled (FIFO_CRON_KEY unset)" }, { status: 503 });
  const sent = Buffer.from(req.headers.get("x-cron-key") ?? "");
  const want = Buffer.from(key);
  if (sent.length !== want.length || !timingSafeEqual(sent, want))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return null;
}

/** Record a finished run. `everySeconds` is how often the crontab is expected to call the job. */
export async function beat(job: string, everySeconds: number | null, ok: boolean, result?: unknown, startedAt: Date = new Date()): Promise<void> {
  const error = ok ? null : String((result as { error?: unknown } | undefined)?.error ?? "failed").slice(0, 500);
  await rows("audit", `
    INSERT INTO job_heartbeats (job, expected_every_s, last_started_at, last_finished_at, last_ok, last_error, last_result, runs)
    VALUES ($1, $2, $3, now(), $4, $5, $6::jsonb, 1)
    ON CONFLICT (job) DO UPDATE SET
      expected_every_s = EXCLUDED.expected_every_s, last_started_at = EXCLUDED.last_started_at,
      last_finished_at = now(), last_ok = EXCLUDED.last_ok, last_error = EXCLUDED.last_error,
      last_result = EXCLUDED.last_result, runs = job_heartbeats.runs + 1
  `, [job, everySeconds, startedAt.toISOString(), ok, error, JSON.stringify(result ?? null)]).catch(() => {});
}

/** Run a job's work and record the run. The work's own error is recorded, then thrown on. */
export async function runJob<T>(job: string, everySeconds: number | null, work: () => Promise<T>): Promise<T> {
  const startedAt = new Date();
  try {
    const out = await work();
    await beat(job, everySeconds, true, out, startedAt);
    return out;
  } catch (err) {
    await beat(job, everySeconds, false, { error: (err as Error).message }, startedAt);
    throw err;
  }
}

export interface JobStatus {
  job: string;
  expected_every_s: number | null;
  last_finished_at: string | null;
  last_ok: boolean | null;
  last_error: string | null;
  age_seconds: number | null;
  /** Not run for more than three times its expected interval (and at least five minutes). */
  stale: boolean;
}

export async function jobStatuses(): Promise<JobStatus[]> {
  return rows<JobStatus>("audit", `
    SELECT job, expected_every_s, last_finished_at, last_ok, last_error,
           EXTRACT(EPOCH FROM (now() - last_finished_at))::int AS age_seconds,
           (expected_every_s IS NOT NULL AND last_finished_at IS NOT NULL
             AND now() - last_finished_at > make_interval(secs => GREATEST(expected_every_s * 3, 300))) AS stale
      FROM job_heartbeats ORDER BY job
  `).catch(() => []);
}

export async function staleJobs(): Promise<JobStatus[]> {
  return (await jobStatuses()).filter((j) => j.stale);
}
