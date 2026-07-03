// PoolPay pay-in proof access for ops (SUPER_ADMIN).
//   GET            — list proofs submitted for an order (metadata only).
//   GET ?file=<id> — stream a single proof file inline so the reviewer can view the
//                    screenshot before confirming. Files live outside the public web
//                    root; this gated endpoint is the only way to read them back.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { readFile } from "fs/promises";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const fileId = new URL(req.url).searchParams.get("file");

  try {
    if (fileId) {
      const p = (await rows<{ storage_ref: string; content_type: string; filename: string | null }>(
        "vendorGateway",
        `SELECT storage_ref, content_type, filename FROM vendor_payin_proofs WHERE id = $1::uuid AND order_id = $2::uuid`,
        [fileId, id]))[0];
      if (!p) return NextResponse.json({ error: "proof not found" }, { status: 404 });
      const buf = await readFile(p.storage_ref);
      return new NextResponse(new Uint8Array(buf), {
        headers: {
          "content-type": p.content_type,
          "content-disposition": `inline; filename="${(p.filename ?? "proof").replace(/"/g, "")}"`,
          "cache-control": "private, no-store",
        },
      });
    }

    const proofs = await rows<any>("vendorGateway", `
      SELECT id::text, kind, utr, filename, content_type, size_bytes::text, sha256, review_status, uploaded_by, created_at
        FROM vendor_payin_proofs WHERE order_id = $1::uuid ORDER BY created_at DESC
    `, [id]);
    return NextResponse.json({ proofs });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
