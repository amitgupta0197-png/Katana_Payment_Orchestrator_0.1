// /api/stores/[storeId]/assignment — admin allocation of a store's live QR endpoint.
//   GET  — candidate QRs plus this store's switch history.
//   POST — allocate or move the store onto a QR { to_qr_id, reason?, idempotency_key? }
//
// This is the FIRST allocation path as well as the admin switch path: a store with no active
// assignment has no banker yet, so `switchStoreQr` is called with bankerCode = null and any
// approved, free QR is a valid target. Once a store HAS a banker, the same same-banker rule
// the banker portal enforces applies here too — cross-banker failover is BRD module 06 and
// is not built yet, so it is refused rather than half-done.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { rows, pgError } from "@/lib/pg";
import { switchStoreQr, switchHttpStatus, switchHistoryForStore } from "@/lib/qr-switch";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ storeId: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "OPERATOR"]);
  if ("response" in g) return g.response;
  const { storeId } = await params;

  try {
    const store = await rows<{ banker_code: string | null }>("provider", `
      SELECT a.banker_code
        FROM merchant_store s
        LEFT JOIN merchant_store_qr_assignment a ON a.store_id = s.id AND a.is_active
       WHERE s.id = $1::uuid
    `, [storeId]);
    if (!store.length) return NextResponse.json({ error: "store not found" }, { status: 404 });
    const currentBanker = store[0].banker_code;

    // With a banker already on the store the candidate list is that banker's free pool;
    // with none, it is every approved free QR, because this is the first allocation.
    const candidates = await rows("provider", `
      SELECT q.id::text, q.banker_code, q.provider, q.upi_id, q.settlement_type,
             q.daily_limit::float AS daily_limit, q.remarks, q.routing_status, q.created_at
        FROM banker_qr q
       WHERE q.approval_status = 'APPROVED'
         AND q.routing_status <> 'PAUSED'
         AND ($2::text IS NULL OR q.banker_code = $2)
         AND NOT EXISTS (
               SELECT 1 FROM merchant_store_qr_assignment a
                WHERE a.qr_id = q.id AND a.is_active
             )
       ORDER BY q.banker_code, q.created_at DESC
       LIMIT 200
    `, [storeId, currentBanker]);

    return NextResponse.json({
      current_banker_code: currentBanker,
      candidates,
      history: await switchHistoryForStore(storeId),
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function POST(req: Request, { params }: { params: Promise<{ storeId: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { storeId } = await params;

  let body: { to_qr_id?: string; reason?: string; idempotency_key?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON body required" }, { status: 400 }); }
  const toQrId = String(body.to_qr_id ?? "").trim();
  if (!toQrId) return NextResponse.json({ error: "to_qr_id is required" }, { status: 400 });

  try {
    const result = await switchStoreQr({
      storeId,
      toQrId,
      actor: s.email,
      actorRole: s.persona,
      bankerCode: null,               // admin: may perform the first allocation
      reason: body.reason?.trim() || null,
      idempotencyKey: body.idempotency_key?.trim() || null,
    });

    if (!result.ok)
      return NextResponse.json({ error: result.message, code: result.code }, { status: switchHttpStatus(result.code) });

    return NextResponse.json(result);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
