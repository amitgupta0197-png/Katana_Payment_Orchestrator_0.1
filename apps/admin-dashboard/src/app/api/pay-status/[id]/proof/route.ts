// PUBLIC sender payment-proof upload (no session — the order id in the URL is the
// capability, same model as the hosted /pay page and /api/pay-status status poll).
// Whitelisted in middleware (PUBLIC_API_PREFIX = /api/pay-status).
//
// The sender, after paying by UPI, uploads a screenshot of the payment so the
// receiver can verify the credit. A screenshot is self-asserted, low-trust evidence,
// so this only parks the order in PROOF_SUBMITTED (it does NOT mark it paid) — ops
// reviews the proof and confirms it via /api/vendors/poolpay/order/:id/confirm.
// Hardened like the KYB / FIFO proof uploads: type allow-list, size cap, magic-byte
// content scan, SHA-256 hash, file stored outside the public web root.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { createHash, randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { attachPayinProof } from "@/lib/poolpay-order";
import { POOLPAY_TERMINAL } from "@/lib/poolpay";

export const dynamic = "force-dynamic";

const STORE = process.env.PAYIN_PROOF_STORE ?? "/opt/katana/payin-proofs"; // outside public root
const ALLOWED = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
const MAX_BYTES = 8 * 1024 * 1024;

function magicMatches(buf: Buffer, ct: string): boolean {
  if (buf.length < 12) return false;
  if (ct === "image/png") return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (ct === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ct === "application/pdf") return buf.subarray(0, 5).toString("latin1") === "%PDF-";
  if (ct === "image/webp") return buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  let fd: FormData;
  try { fd = await req.formData(); } catch { return NextResponse.json({ error: "multipart form required" }, { status: 400 }); }
  const file = fd.get("file");
  const utr = (String(fd.get("utr") ?? "").trim() || null);
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "file too large (max 8MB)" }, { status: 413 });
  const ct = file.type || "application/octet-stream";
  if (!ALLOWED.includes(ct)) return NextResponse.json({ error: `content-type ${ct} not allowed (PNG/JPEG/WEBP/PDF only)` }, { status: 415 });

  try {
    const found = await rows<{ id: string; order_id: string; status: string }>("vendorGateway",
      `SELECT id::text, order_id, status FROM vendor_payin_orders WHERE id = $1::uuid AND vendor = 'POOLPAY'`, [id]);
    if (!found.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    const order = found[0];
    if (POOLPAY_TERMINAL.has(order.status))
      return NextResponse.json({ error: `order already ${order.status} — proof not needed` }, { status: 409 });

    const buf = Buffer.from(await file.arrayBuffer());
    if (!magicMatches(buf, ct))
      return NextResponse.json({ error: "file content does not match its type (failed scan)" }, { status: 415 });

    const sha = createHash("sha256").update(buf).digest("hex");
    const ext = ct === "application/pdf" ? "pdf" : (ct.split("/")[1] || "bin");
    const dir = path.join(STORE, id);
    await mkdir(dir, { recursive: true });
    const storageRef = path.join(dir, `proof_${sha.slice(0, 16)}_${randomBytes(4).toString("hex")}.${ext}`);
    await writeFile(storageRef, buf, { mode: 0o600 });

    const { proof_id } = await attachPayinProof({
      orderId: order.id, orderRef: order.order_id, utr,
      filename: file.name || null, contentType: ct, sizeBytes: buf.length,
      sha256: sha, storageRef, uploadedBy: "sender",
    });

    return NextResponse.json({ ok: true, proof_id, status: "PROOF_SUBMITTED" });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
