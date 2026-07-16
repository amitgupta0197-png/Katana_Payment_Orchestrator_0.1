// POST /api/v1/dt/refills/{id} — drive a refill request's lifecycle (BRD §16):
// OPEN → FUNDED → VERIFIED → CLOSED, with CANCELLED allowed while not yet verified.
// Admin/Finance-side only; bankers raise requests but never transition them.
//
// Settlement-buffer model (product decision 2026-07-16, supersedes release-on-refill):
// verifying a refill materialises a NEW ACTIVE lot (quantity × current rate, 60%
// traffic quota + 40% buffer) and ADDS that 40% to the banker's outstanding
// settlement buffer. Previous reserves are NOT released — a small refill can never
// reduce Katana's security position. Only verified settlement reconciliation
// (POST /api/v1/dt/settlements) releases buffer, FIFO across lots.
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { rows } from "@/lib/pg";
import { auditDt, currentRate, addBufferEntry } from "@/lib/dt";

export const dynamic = "force-dynamic";

const NEXT: Record<string, string[]> = {
  OPEN: ["FUNDED", "CANCELLED"],
  FUNDED: ["VERIFIED", "CANCELLED"],
  VERIFIED: ["CLOSED"],
};

const schema = z.object({ to: z.enum(["FUNDED", "VERIFIED", "CLOSED", "CANCELLED"]) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const cur = await rows<{ status: string; banker_id: string; quantity: number | null }>("provider",
    `SELECT status, banker_id, quantity::float AS quantity FROM dt_refill_requests WHERE id = $1::uuid`, [id]).catch(() => []);
  if (!cur.length) return NextResponse.json({ error: "refill request not found" }, { status: 404 });
  if (!(NEXT[cur[0].status] ?? []).includes(body.to))
    return NextResponse.json({ error: `cannot move ${cur[0].status} → ${body.to}` }, { status: 409 });

  let result: Record<string, unknown> | null = null;
  if (body.to === "VERIFIED") {
    const bankerId = cur[0].banker_id;
    const quantity = cur[0].quantity;
    if (!quantity || quantity <= 0)
      return NextResponse.json({ error: "refill has no DT quantity — the banker must raise it with a quantity before it can be verified" }, { status: 400 });
    const rate = await currentRate();
    if (!rate) return NextResponse.json({ error: "no active DT rate card — set the rate on the DT Dashboard first" }, { status: 400 });

    const total = +(quantity * rate.rate).toFixed(2);
    const allocated = +(total * 0.6).toFixed(2);
    const held = +(total * 0.4).toFixed(2);

    // New ACTIVE lot from the refill (60/40, rate snapshotted like a purchase).
    const lot = await rows<{ id: string }>("provider", `
      INSERT INTO dt_purchases (banker_id, quantity, buy_rate, total_amount, priority_percent, security_percent, status, payment_ref, created_by, approved_by)
      VALUES ($1,$2,$3,$4,60,40,'ACTIVE',$5,$6,$6) RETURNING id::text
    `, [bankerId, quantity, rate.rate, total, `REFILL:${id}`, g.session.email]);
    await rows("provider", `
      INSERT INTO traffic_allocations (purchase_id, priority_percent, allocated) VALUES ($1,60,$2)
    `, [lot[0].id, allocated]);
    await rows("provider", `
      INSERT INTO security_reserves (purchase_id, reserve_percent, held) VALUES ($1,40,$2)
    `, [lot[0].id, held]);

    // The refill's 40% ACCUMULATES into the outstanding settlement buffer.
    const buf = await addBufferEntry(bankerId, {
      added: held, refPurchaseId: lot[0].id, note: `refill ${id} verified`, actor: g.session.email,
    });

    // Exhausted lots are now refilled (quota lifecycle only — reserves untouched).
    await rows("provider", `
      UPDATE dt_purchases SET status = 'REFILLED', updated_at = now()
       WHERE banker_id = $1 AND status = 'EXHAUSTED'
    `, [bankerId]).catch(() => {});

    result = {
      new_lot_id: lot[0].id, quantity, rate: rate.rate, total,
      traffic_quota: allocated, buffer_added: held,
      outstanding_buffer: buf.closing,
    };
  }

  await rows("provider", `UPDATE dt_refill_requests SET status = $2 WHERE id = $1::uuid`, [id, body.to]);
  await auditDt(g.session.email, `REFILL_${body.to}`, "dt_refill_request", id,
    { status: cur[0].status }, { status: body.to, banker_id: cur[0].banker_id, ...(result ?? {}) });
  return NextResponse.json({ ok: true, ...(result ? { buffer: result } : {}) });
}
