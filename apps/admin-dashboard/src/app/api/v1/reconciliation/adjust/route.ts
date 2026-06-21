// POST /api/v1/reconciliation/adjust — raise a maker-checker adjustment for a
// reconciliation mismatch item (BRD §21: "all manual adjustments require
// maker-checker approval and reason code"). Approval is decided on /payouts via
// /api/v1/approvals/[id]/decide, which resolves the item.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const schema = z.object({ item_id: z.string().uuid(), reason: z.string().min(3) });

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE"]);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try {
    const it = (await rows<any>("fifo", `SELECT id::text, order_ref, bucket, resolved FROM fifo_recon_items WHERE id=$1::uuid`, [body.item_id]))[0];
    if (!it) return NextResponse.json({ error: "recon item not found" }, { status: 404 });
    if (it.resolved) return NextResponse.json({ error: "already resolved" }, { status: 409 });
    await rows("fifo", `
      INSERT INTO fifo_approvals (action_type, resource_type, resource_id, order_ref, detail, maker)
      VALUES ('RECON_ADJUSTMENT','recon_item',$1,$2,$3,$4)
    `, [it.id, it.order_ref, `Resolve ${it.bucket}: ${body.reason}`, g.session.email]);
    return NextResponse.json({ ok: true, status: "PENDING_APPROVAL" }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
