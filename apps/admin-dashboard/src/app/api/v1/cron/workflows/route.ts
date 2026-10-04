// POST /api/v1/cron/workflows — the workflow engine's clock (lib/workflow-store).
//   1. syncAll: start the onboarding / issuance instances that should be running, then bring every
//      open instance up to date with the real state (stage, MIDs, Maker-Checker requests)
//   2. SLA: one ops alert per instance whose current step is past its timeout; closed again when
//      it is not
// Idempotent; it only reads the real states and writes the workflow tables.
// Cron-authenticated (x-cron-key). Schedule every 5 minutes:
//   */5 * * * * curl -s -X POST -H "x-cron-key: $FIFO_CRON_KEY" http://127.0.0.1:3100/api/v1/cron/workflows

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { cronGate, runJob } from "@/lib/jobs";
import { alertBreaches, syncAll } from "@/lib/workflow-store";
import { setAlert } from "@/lib/ops-alert";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = cronGate(req);
  if (denied) return denied;
  try {
    const out = await runJob("workflows", 300, async () => {
      const sync = await syncAll();
      const sla = await alertBreaches();
      return { ...sync, errors: sync.errors.slice(0, 20), sla };
    });
    await setAlert(out.errors.length > 0, {
      key: "workflows:errors", severity: "WARN", repeatMinutes: 180,
      title: `Workflows: ${out.errors.length} instance${out.errors.length === 1 ? "" : "s"} could not be synced`,
      body: out.errors.slice(0, 8).join("\n"),
    }).catch(() => {});
    return NextResponse.json({ ok: true, ...out });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
