// /api/banker-portal/qr-switch
//   GET  — the stores this banker is currently collecting for, plus the QRs it could move
//          them onto.
//   POST — move one store onto another of this banker's QRs. Executes immediately.
//
// BANKER-scoped throughout: the MERCHANT persona's scope_id IS merchants.merchant_code,
// which is the banker_code these tables key on, so a banker can only ever see and switch
// stores it is itself serving. The scope is never taken from the request body.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { pgError } from "@/lib/pg";
import {
  storesServedByBanker,
  availableQrsForBanker,
  switchStoreQr,
  switchHttpStatus,
} from "@/lib/qr-switch";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;
  const code = g.session.scope_id;
  if (!code) return NextResponse.json({ error: "MERCHANT session missing scope_id" }, { status: 400 });

  try {
    const [stores, available] = await Promise.all([
      storesServedByBanker(code),
      availableQrsForBanker(code),
    ]);
    return NextResponse.json({ banker_code: code, stores, available_qrs: available });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function POST(req: Request) {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const code = s.scope_id;
  if (!code) return NextResponse.json({ error: "MERCHANT session missing scope_id" }, { status: 400 });

  let body: { store_id?: string; to_qr_id?: string; reason?: string; idempotency_key?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON body required" }, { status: 400 }); }

  const storeId = String(body.store_id ?? "").trim();
  const toQrId = String(body.to_qr_id ?? "").trim();
  if (!storeId || !toQrId)
    return NextResponse.json({ error: "store_id and to_qr_id are required" }, { status: 400 });

  try {
    const result = await switchStoreQr({
      storeId,
      toQrId,
      actor: s.email,
      actorRole: "MERCHANT",
      // Pinned to the session, never to the body — this is what stops a banker switching
      // a store it does not serve, or onto a QR it does not own.
      bankerCode: code,
      reason: body.reason?.trim() || null,
      idempotencyKey: body.idempotency_key?.trim() || null,
    });

    if (!result.ok)
      return NextResponse.json({ error: result.message, code: result.code }, { status: switchHttpStatus(result.code) });

    return NextResponse.json(result);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
