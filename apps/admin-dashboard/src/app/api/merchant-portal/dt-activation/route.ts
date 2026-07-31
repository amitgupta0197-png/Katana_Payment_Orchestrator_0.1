// Merchant side of DT activation (2026-07-31).
//
//   GET  — this merchant's activation state: approved / pending / rejected / none.
//   POST — ask to be activated for the DT refill model, declaring the channel model.
//
// A merchant can only ever act on its own scope_id; the merchant id is taken from the
// session and never from the request body.
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { rows, pgError } from "@/lib/pg";
import { auditDt } from "@/lib/dt";
import { activationFor, ACTIVATION_MODELS } from "@/lib/dt-activation";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;
  const merchantId = g.session.scope_id;
  if (!merchantId) return NextResponse.json({ error: "MERCHANT session missing scope_id" }, { status: 400 });

  const current = await activationFor(merchantId);
  const history = await rows<any>("provider", `
    SELECT id::text, model, status, COALESCE(review_note,'') AS review_note,
           requested_at, reviewed_at, COALESCE(reviewed_by,'') AS reviewed_by
      FROM merchant_dt_activations WHERE merchant_id = $1
     ORDER BY requested_at DESC LIMIT 20
  `, [merchantId]).catch(() => []);

  return NextResponse.json({
    merchant_id: merchantId,
    activation: current,
    activated: current?.status === "APPROVED",
    history,
  });
}

const schema = z.object({
  model: z.enum(ACTIVATION_MODELS),
  note: z.string().trim().max(1000).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;
  const merchantId = g.session.scope_id;
  if (!merchantId) return NextResponse.json({ error: "MERCHANT session missing scope_id" }, { status: 400 });

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const current = await activationFor(merchantId);
  if (current?.status === "APPROVED")
    return NextResponse.json({ error: "already activated for the DT refill model" }, { status: 409 });
  if (current?.status === "REQUESTED")
    return NextResponse.json({ error: "a request is already pending review" }, { status: 409 });

  try {
    const r = await rows<{ id: string }>("provider", `
      INSERT INTO merchant_dt_activations (merchant_id, model, status, request_note, requested_by)
      VALUES ($1,$2,'REQUESTED',$3,$4) RETURNING id::text
    `, [merchantId, body.model, body.note ?? null, g.session.email]);

    await auditDt(g.session.email, "DT_ACTIVATION_REQUEST", "merchant_dt_activation", r[0].id, null,
      { merchant_id: merchantId, model: body.model });

    return NextResponse.json({ ok: true, id: r[0].id, status: "REQUESTED" });
  } catch (err) {
    const e = pgError(err);
    // The partial unique index is the real guard against a double-click; the checks
    // above are only a friendlier first line.
    if (e.status === 409 || /unique/i.test(JSON.stringify(e.body)))
      return NextResponse.json({ error: "a request is already pending review" }, { status: 409 });
    return NextResponse.json(e.body, { status: e.status });
  }
}
