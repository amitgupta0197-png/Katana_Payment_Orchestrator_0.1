// Merchant-raised DT requests (flow change 2026-07-31).
//
// The merchant asks for DT against a banker; the banker later confirms the DT was
// received (POST /api/banker-portal/purchases), which is the step that activates the
// lot and creates the 60/40 quota + reserve.
//
//   GET  — this merchant's own requests only, never another merchant's.
//   POST — raise a request. Lands in PENDING_APPROVAL, so a merchant can never mint an
//          ACTIVE lot: the existing maker-checker and funding steps still apply.
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { rows, pgError } from "@/lib/pg";
import { auditDt, currentRate } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;
  const merchantId = g.session.scope_id;
  if (!merchantId) return NextResponse.json({ error: "MERCHANT session missing scope_id" }, { status: 400 });

  const [purchases, refills, rate] = await Promise.all([
    rows<any>("provider", `
      SELECT id::text, banker_id, quantity::float AS quantity, buy_rate::float AS buy_rate,
             total_amount::float AS total_amount, status,
             COALESCE(received_confirmed_by,'') AS received_confirmed_by, received_confirmed_at,
             created_by, created_at
        FROM dt_purchases
       WHERE requested_by_merchant = $1
       ORDER BY created_at DESC LIMIT 200
    `, [merchantId]).catch(() => []),
    rows<any>("provider", `
      SELECT id::text, banker_id, quantity::float AS quantity, trigger, status,
             COALESCE(received_confirmed_by,'') AS received_confirmed_by, received_confirmed_at,
             created_at
        FROM dt_refill_requests
       WHERE requested_by_merchant = $1
       ORDER BY created_at DESC LIMIT 200
    `, [merchantId]).catch(() => []),
    currentRate(),
  ]);

  // Bankers the merchant can raise against — id and label ONLY. Deliberately not the
  // admin /api/v1/dt/bankers payload, which carries banker login emails and account
  // status that a merchant has no business seeing.
  const bankers = await rows<any>("iam", `
    SELECT COALESCE(scope_id,'') AS banker_id, COALESCE(scope_label,'') AS label
      FROM user_personas
     WHERE persona_kind = 'BANKER' AND scope_id IS NOT NULL
     GROUP BY scope_id, scope_label
     ORDER BY scope_id
     LIMIT 200
  `).catch(() => []);

  return NextResponse.json({ merchant_id: merchantId, purchases, refills, rate, bankers });
}

const schema = z.object({
  banker_id: z.string().trim().min(1).max(120),
  quantity: z.number().positive(),
  kind: z.enum(["PURCHASE", "REFILL"]).default("PURCHASE"),
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

  try {
    if (body.kind === "REFILL") {
      const r = await rows<{ id: string }>("provider", `
        INSERT INTO dt_refill_requests (banker_id, quantity, trigger, status, created_by, requested_by_merchant)
        VALUES ($1,$2,'MANUAL','OPEN',$3,$4) RETURNING id::text
      `, [body.banker_id, body.quantity, g.session.email, merchantId]);
      await auditDt(g.session.email, "REFILL_CREATE_MERCHANT", "dt_refill_request", r[0].id, null,
        { banker_id: body.banker_id, quantity: body.quantity, merchant_id: merchantId });
      return NextResponse.json({ ok: true, id: r[0].id, kind: "REFILL" });
    }

    // Price at the CURRENT rate so the merchant sees the advance they are asking for.
    // The rate is re-snapshotted on activation, so a rate move between request and
    // confirmation is reflected in the lot rather than silently honoured at the old price.
    const rate = await currentRate();
    if (!rate) return NextResponse.json({ error: "no active DT rate card — ask Katana to set the DT rate" }, { status: 400 });
    const total = +(body.quantity * rate.rate).toFixed(2);

    const r = await rows<{ id: string }>("provider", `
      INSERT INTO dt_purchases
        (banker_id, quantity, buy_rate, total_amount, priority_percent, security_percent,
         status, created_by, requested_by_merchant)
      VALUES ($1,$2,$3,$4,60,40,'PENDING_APPROVAL',$5,$6)
      RETURNING id::text
    `, [body.banker_id, body.quantity, rate.rate, total, g.session.email, merchantId]);

    await auditDt(g.session.email, "PURCHASE_REQUEST_MERCHANT", "dt_purchase", r[0].id, null,
      { banker_id: body.banker_id, quantity: body.quantity, rate: rate.rate, total, merchant_id: merchantId });

    return NextResponse.json({ ok: true, id: r[0].id, kind: "PURCHASE", quantity: body.quantity, rate: rate.rate, total });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
