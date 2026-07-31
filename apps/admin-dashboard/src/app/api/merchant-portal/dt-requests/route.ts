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
import { activationFor } from "@/lib/dt-activation";

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

  // Pay-ins this branch has actually collected. Only SUCCESS counts — an EXPIRED or
  // PENDING order is not money in, and including it would overstate consumption
  // against the DT quota.
  const [collected] = await rows<any>("checkout", `
    SELECT COALESCE(SUM(amount),0)::float AS total,
           COUNT(*)::int AS count,
           COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('day', now())),0)::float AS today
      FROM checkout_orders
     WHERE merchant_id = $1 AND status = 'SUCCESS'
  `, [merchantId]).catch(() => [{ total: 0, count: 0, today: 0 }]);

  // The ledger: each collected pay-in as a line, newest first. This is what the
  // activated dashboard tracks against the branch's DT position.
  const ledger = await rows<any>("checkout", `
    SELECT id::text, COALESCE(client_ref,'') AS client_ref, COALESCE(txn_id,'') AS txn_id,
           amount::float AS amount, currency, COALESCE(method,'') AS method,
           COALESCE(selected_rail,'') AS rail, status, created_at
      FROM checkout_orders
     WHERE merchant_id = $1 AND status = 'SUCCESS'
     ORDER BY created_at DESC LIMIT 200
  `, [merchantId]).catch(() => []);

  // The branch's own DT position: quota bought through its ACTIVE lots, and what the
  // collections have consumed of it. Derived here so the merchant sees one consistent
  // number rather than computing it in the browser.
  const [position] = await rows<any>("provider", `
    SELECT COALESCE(SUM(a.allocated),0)::float AS quota,
           COALESCE(SUM(a.consumed),0)::float  AS consumed,
           COALESCE(SUM(a.reserved),0)::float  AS reserved,
           COALESCE(SUM(GREATEST(s.held - s.released,0)),0)::float AS reserve_held
      FROM dt_purchases p
      LEFT JOIN traffic_allocations a ON a.purchase_id = p.id
      LEFT JOIN security_reserves  s ON s.purchase_id = p.id
     WHERE p.requested_by_merchant = $1 AND p.status = 'ACTIVE'
  `, [merchantId]).catch(() => [{ quota: 0, consumed: 0, reserved: 0, reserve_held: 0 }]);

  const quota = position?.quota ?? 0;
  const available = +((quota - (position?.reserved ?? 0) - (position?.consumed ?? 0))).toFixed(2);

  return NextResponse.json({
    merchant_id: merchantId, purchases, refills, rate, bankers,
    collections: { ...collected, ledger },
    position: { ...position, available, utilization: quota > 0 ? +(((position?.consumed ?? 0) / quota) * 100).toFixed(1) : 0 },
  });
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

  // Enforced server-side, not just hidden in the UI: a merchant that has not been
  // activated for the DT refill model cannot raise a request by calling the API
  // directly. This is the whole point of the activation gate.
  const activation = await activationFor(merchantId);
  if (activation?.status !== "APPROVED")
    return NextResponse.json({
      error: activation?.status === "REQUESTED"
        ? "your DT activation request is still awaiting approval"
        : "this branch is not activated for the DT refill model — raise an activation request first",
      activation_status: activation?.status ?? "NONE",
    }, { status: 403 });

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
