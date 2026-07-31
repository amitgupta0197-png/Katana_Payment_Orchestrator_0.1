// POST /api/settlements/[id]/transition — the single settlement state-machine endpoint.
// Every status action (Accept, Start, Mark paid, Confirm, Reconcile, …) goes through here.
// It validates the requested action against the FSM (lib/settlement-fsm) for the caller's
// role + current status + mandatory data, updates the settlement row, appends an immutable
// timeline event, and writes the provider audit log — atomically enough that the timeline
// always mirrors the row.
//
//   UPLINE  = PROVIDER (own settlements)   DOWNLINE = MERCHANT (own branch)   ADMIN = SUPER_ADMIN

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { branchKeysForMerchant } from "@/lib/provider-integration";
import { settlementRole, findTransition, validateTransition } from "@/lib/settlement-fsm";
import { notifySettlementEvent } from "@/lib/settlement-notify";
import { currentUsdtRate, computeUsdtQuantity } from "@/lib/settlement-rules";

export const dynamic = "force-dynamic";

const schema = z.object({
  action: z.string().min(1),
  remarks: z.string().max(1000).optional(),
  // Free-form mandatory-data bag (paid_amount, payment_mode, payment_date, utr,
  // source_bank, reason, receipt_uri, …). Validated per-action by the FSM.
  details: z.record(z.string(), z.unknown()).optional(),
});

// Columns we mirror out of `details` onto first-class settlement fields when present.
const MIRROR: Record<string, string> = {
  utr: "utr", paid_amount: "paid_amount", payment_mode: "payment_mode",
  payment_date: "payment_date", source_bank: "source_bank", receipt_uri: "receipt_uri",
  tx_hash: "tx_hash", usdt_quantity: "usdt_quantity", usdt_rate: "usdt_rate",
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  const role = settlementRole(s.persona);
  if (!role) return NextResponse.json({ error: "your role cannot act on settlements" }, { status: 403 });

  let body: z.infer<typeof schema>;
  try { body = schema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const details = body.details ?? {};
  if (body.remarks) details.reason = details.reason ?? body.remarks;

  try {
    const cur = (await rows<{ id: string; provider_id: string; merchant_key: string; status: string; amount: number; settle_mode: string; request_ref: string | null; net_amount: number | null; locked: boolean; usdt_network: string | null }>(
      "provider",
      `SELECT id::text, provider_id::text, merchant_key, status, amount::float AS amount,
              COALESCE(settle_mode, 'BANK') AS settle_mode, request_ref, net_amount::float AS net_amount,
              COALESCE(locked, false) AS locked, usdt_network
         FROM provider_branch_settlements WHERE id = $1::uuid`, [id]))[0];
    if (!cur) return NextResponse.json({ error: "settlement not found" }, { status: 404 });

    // Scope: upline owns the provider; downline owns the addressed branch.
    if (role === "UPLINE" && s.scope_id !== cur.provider_id)
      return NextResponse.json({ error: "not your settlement" }, { status: 403 });
    if (role === "DOWNLINE") {
      const keys = await branchKeysForMerchant(s.scope_id!);
      if (!keys.includes(cur.merchant_key))
        return NextResponse.json({ error: "this settlement is not addressed to your branch" }, { status: 403 });
    }

    const t = findTransition(body.action);
    if (!t) return NextResponse.json({ error: `unknown action ${body.action}` }, { status: 400 });
    const invalid = validateTransition(body.action, cur.status, role, details, cur.settle_mode as "BANK" | "USDT", cur.locked);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 409 });

    // "*" = event-only action (clarify / lock / unlock): status stays where it is.
    const toStatus = t.to === "*" ? cur.status : t.to;

    // Build the mirrored-column SET fragment from whatever `details` carries.
    const sets: string[] = ["status = $2", "updated_at = now()"];
    const args: unknown[] = [id, toStatus];
    for (const [key, col] of Object.entries(MIRROR)) {
      if (details[key] !== undefined && details[key] !== null && details[key] !== "") {
        args.push(details[key]); sets.push(`${col} = $${args.length}`);
      }
    }
    // Role/stage lifecycle stamps.
    const stamp = (byCol: string, atCol: string) => {
      args.push(s.email); sets.push(`${byCol} = $${args.length}`); sets.push(`${atCol} = now()`);
    };
    if (t.action === "ACCEPT") {
      stamp("accepted_by", "accepted_at");
      // §9 configurable rate-lock basis: default locks at request CREATION; set
      // USDT_RATE_LOCK_BASIS=ACCEPTANCE to re-lock at downline acceptance instead.
      if (cur.settle_mode === "USDT" && process.env.USDT_RATE_LOCK_BASIS === "ACCEPTANCE" && cur.usdt_network) {
        const rate = await currentUsdtRate(cur.usdt_network);
        if (rate && cur.net_amount != null) {
          const q = computeUsdtQuantity(cur.net_amount, rate);
          args.push(rate.settlement_rate); sets.push(`usdt_rate = $${args.length}`);
          args.push(q.final_qty); sets.push(`usdt_quantity = $${args.length}`);
          args.push(q.fee); sets.push(`usdt_fee = $${args.length}`);
          details.rate_relocked_at_acceptance = rate.settlement_rate;
        }
      }
    }
    if (t.action === "MARK_PAID" || t.action === "MARK_PARTIAL" || t.action === "MARK_USDT_TRANSFERRED") stamp("utr_submitted_by", "paid_at");
    // §8 admin controls: lock/unlock freeze flag; reassign moves the request to a new
    // branch and restarts it at REQUESTED (only offered pre-payment by the FSM).
    if (t.action === "LOCK") sets.push("locked = true");
    if (t.action === "UNLOCK") sets.push("locked = false");
    if (t.action === "REASSIGN") {
      const nb = String(details.new_branch ?? "").trim();
      if (!nb) return NextResponse.json({ error: "new_branch is required to reassign" }, { status: 400 });
      args.push(nb); sets.push(`merchant_key = $${args.length}`);
    }
    // Confirm = the upline's verification; keep the legacy verified_by/at in sync so old
    // reports and the outstanding calc (which keys on VERIFIED) keep working.
    if (t.action === "CONFIRM") { stamp("confirmed_by", "confirmed_at"); args.push(s.email); sets.push(`verified_by = $${args.length}`); sets.push(`verified_at = now()`); }
    if (t.action === "RECONCILE") stamp("reconciled_by", "reconciled_at");
    if (t.action === "MARK_FAILED" && details.reason) { args.push(String(details.reason)); sets.push(`failure_reason = $${args.length}`); }
    // Merge the whole details bag into the jsonb column for full evidence retention.
    args.push(JSON.stringify(details)); sets.push(`details = details || $${args.length}::jsonb`);
    if (body.remarks) { args.push(body.remarks); sets.push(`note = $${args.length}`); }

    const upd = await rows<{ id: string; status: string }>(
      "provider",
      `UPDATE provider_branch_settlements SET ${sets.join(", ")} WHERE id = $1::uuid RETURNING id::text, status`, args);

    // Immutable timeline event.
    await rows("provider", `
      INSERT INTO provider_settlement_events (settlement_id, provider_id, action, from_status, to_status, actor, actor_role, remarks, details)
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb)
    `, [id, cur.provider_id, t.action, cur.status, toStatus, s.email, role, body.remarks ?? null, JSON.stringify(details)]).catch(() => {});

    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
      VALUES ($1::uuid, $2, $3, $4::jsonb)
    `, [cur.provider_id, s.email, `provider.settlement.${t.action.toLowerCase()}`,
        JSON.stringify({ settlement_id: id, from: cur.status, to: toStatus, role })]).catch(() => {});

    // BRD §7: push the change to the provider's external channels (signed webhook).
    // Fire-and-forget — never blocks the response. Event-only actions publish the
    // action name (settlement.clarify) since the status didn't change.
    void notifySettlementEvent(cur.provider_id, {
      event: t.to === "*" ? `settlement.${t.action.toLowerCase()}` : `settlement.${toStatus.toLowerCase()}`,
      request_ref: cur.request_ref, settlement_id: id,
      from_status: cur.status, to_status: toStatus, actor_role: role,
      merchant_key: cur.merchant_key, amount: cur.amount, net_amount: cur.net_amount,
      settle_mode: cur.settle_mode,
      utr: (details.utr as string) ?? null, tx_hash: (details.tx_hash as string) ?? null,
      remarks: body.remarks ?? null, at: new Date().toISOString(),
    });

    return NextResponse.json({ settlement: upd[0], from: cur.status, to: toStatus });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
