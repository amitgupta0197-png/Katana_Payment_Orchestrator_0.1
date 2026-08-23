// /api/qr — admin view of every banker's QR inventory.
//   GET  — all QRs, optionally filtered by ?banker=&status=&provider=.
//   POST — admin adds a QR on a banker's behalf (multipart, same fields as the banker's own
//          upload plus banker_code). Approved at birth: making the approver approve its own
//          row is theatre, and the admin is the approval authority.
import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { rows, pgError } from "@/lib/pg";
import { saveQrImage, createQr, QR_PROVIDERS, SETTLEMENT_TYPES } from "@/lib/qr-switch";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "OPERATOR"]);
  if ("response" in g) return g.response;

  const url = new URL(req.url);
  const banker = url.searchParams.get("banker")?.trim() || null;
  const status = url.searchParams.get("status")?.trim().toUpperCase() || null;
  const provider = url.searchParams.get("provider")?.trim().toUpperCase() || null;

  try {
    // The store a QR is live on is part of "what is this QR doing", so it is joined in here
    // rather than left for the page to stitch together per row.
    const qrs = await rows("provider", `
      SELECT q.id::text, q.banker_code, q.provider, q.upi_id, q.settlement_type,
             q.daily_limit::float AS daily_limit, q.remarks,
             q.approval_status, q.routing_status, q.rejection_reason,
             q.approved_by, q.approved_at, q.created_by, q.created_at,
             (q.qr_image_uri IS NOT NULL) AS has_image,
             s.code AS live_store_code, s.name AS live_store_name,
             p.legal_name AS live_merchant_name
        FROM banker_qr q
        LEFT JOIN merchant_store_qr_assignment a ON a.qr_id = q.id AND a.is_active
        LEFT JOIN merchant_store s ON s.id = a.store_id
        LEFT JOIN providers      p ON p.id = s.provider_id
       WHERE ($1::text IS NULL OR q.banker_code = $1)
         AND ($2::text IS NULL OR q.approval_status = $2)
         AND ($3::text IS NULL OR q.provider = $3)
       ORDER BY (q.approval_status = 'PENDING') DESC, q.created_at DESC
       LIMIT 500
    `, [banker, status, provider]);

    return NextResponse.json({ qrs, providers: QR_PROVIDERS, settlement_types: SETTLEMENT_TYPES });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;

  let fd: FormData;
  try { fd = await req.formData(); } catch { return NextResponse.json({ error: "multipart form required" }, { status: 400 }); }

  const bankerCode = String(fd.get("banker_code") ?? "").trim();
  const upiId = String(fd.get("upi_id") ?? "").trim();
  if (!bankerCode) return NextResponse.json({ error: "banker_code is required" }, { status: 400 });
  if (!upiId) return NextResponse.json({ error: "upi_id is required" }, { status: 400 });

  const rawLimit = String(fd.get("daily_limit") ?? "").trim();
  const dailyLimit = rawLimit ? Number(rawLimit) : null;
  if (dailyLimit !== null && (!Number.isFinite(dailyLimit) || dailyLimit < 0))
    return NextResponse.json({ error: "daily_limit must be a non-negative number" }, { status: 400 });

  try {
    // Fail early on a typo'd banker code: banker_code carries no FK (merchants lives in
    // another database), so nothing else would catch it and the QR would sit in a pool no
    // banker can see.
    const known = await rows<{ merchant_code: string }>("merchant",
      `SELECT merchant_code FROM merchants WHERE merchant_code = $1 LIMIT 1`, [bankerCode]).catch(() => []);
    if (!known.length)
      return NextResponse.json({ error: `no banker with code ${bankerCode}` }, { status: 404 });

    let imageUri: string | null = null;
    let imageSha: string | null = null;
    const file = fd.get("image");
    if (file instanceof File && file.size > 0) {
      const saved = await saveQrImage(file, bankerCode);
      if ("error" in saved) return NextResponse.json({ error: saved.error }, { status: saved.status });
      imageUri = saved.uri;
      imageSha = saved.sha256;
    }

    const created = await createQr({
      bankerCode,
      provider: String(fd.get("provider") ?? ""),
      upiId,
      settlementType: String(fd.get("settlement_type") ?? "INSTANT"),
      dailyLimit,
      remarks: String(fd.get("remarks") ?? "").trim() || null,
      imageUri,
      imageSha,
      createdBy: s.email,
      autoApprove: true,
    });

    if (!created.ok)
      return NextResponse.json({ error: created.message, code: created.code },
        { status: created.code === "DUPLICATE_UPI" ? 409 : 400 });

    return NextResponse.json({ ok: true, qr_id: created.id, approval_status: created.approval_status });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
