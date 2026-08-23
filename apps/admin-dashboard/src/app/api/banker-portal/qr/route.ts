// /api/banker-portal/qr
//   GET  — this banker's whole QR pool, whatever its approval state.
//   POST — add a QR to the pool (multipart: provider, upi_id, settlement_type, daily_limit,
//          remarks, image?). Lands PENDING; an admin approves before it can be switched to.
//
// BANKER-scoped: banker_code always comes from the session, never the body, so a banker
// cannot file a QR under someone else's name.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { pgError } from "@/lib/pg";
import { qrPoolForBanker, saveQrImage, createQr, QR_PROVIDERS, SETTLEMENT_TYPES } from "@/lib/qr-switch";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;
  const code = g.session.scope_id;
  if (!code) return NextResponse.json({ error: "MERCHANT session missing scope_id" }, { status: 400 });

  try {
    return NextResponse.json({
      qrs: await qrPoolForBanker(code),
      providers: QR_PROVIDERS,
      settlement_types: SETTLEMENT_TYPES,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function POST(req: Request) {
  const g = await gateOrResponse(["MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const code = s.scope_id;
  if (!code) return NextResponse.json({ error: "MERCHANT session missing scope_id" }, { status: 400 });

  let fd: FormData;
  try { fd = await req.formData(); } catch { return NextResponse.json({ error: "multipart form required" }, { status: 400 }); }

  const upiId = String(fd.get("upi_id") ?? "").trim();
  if (!upiId) return NextResponse.json({ error: "upi_id is required" }, { status: 400 });

  const rawLimit = String(fd.get("daily_limit") ?? "").trim();
  const dailyLimit = rawLimit ? Number(rawLimit) : null;
  if (dailyLimit !== null && (!Number.isFinite(dailyLimit) || dailyLimit < 0))
    return NextResponse.json({ error: "daily_limit must be a non-negative number" }, { status: 400 });

  try {
    // The image is optional: a banker often knows the VPA before it has a printed QR to
    // photograph, and blocking the record on the picture would just keep the pool empty.
    let imageUri: string | null = null;
    let imageSha: string | null = null;
    const file = fd.get("image");
    if (file instanceof File && file.size > 0) {
      const saved = await saveQrImage(file, code);
      if ("error" in saved) return NextResponse.json({ error: saved.error }, { status: saved.status });
      imageUri = saved.uri;
      imageSha = saved.sha256;
    }

    const created = await createQr({
      bankerCode: code,
      provider: String(fd.get("provider") ?? ""),
      upiId,
      settlementType: String(fd.get("settlement_type") ?? "INSTANT"),
      dailyLimit,
      remarks: String(fd.get("remarks") ?? "").trim() || null,
      imageUri,
      imageSha,
      createdBy: s.email,
      autoApprove: false,
    });

    if (!created.ok)
      return NextResponse.json({ error: created.message, code: created.code },
        { status: created.code === "DUPLICATE_UPI" ? 409 : 400 });

    return NextResponse.json({ ok: true, qr_id: created.id, approval_status: created.approval_status });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
