// POST /api/v1/transactions/proof — operator uploads payment proof (BRD FR-005,
// §23 evidence hashing, SEC-007). Multipart: order_id, kind, file. Stores the
// file outside the public root, records its SHA-256, and advances the order to
// PROOF_UPLOADED.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { transition } from "@/lib/fifo";
import { createHash, randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

const STORE = process.env.PROOF_STORE ?? "/opt/katana/proof-store";   // outside public root
const ALLOWED = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
const MAX_BYTES = 8 * 1024 * 1024;

// Lightweight content scan (SEC-007): confirm magic bytes match the declared type.
function magicMatches(buf: Buffer, ct: string): boolean {
  if (buf.length < 4) return false;
  if (ct === "image/png") return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (ct === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ct === "application/pdf") return buf.subarray(0, 5).toString("latin1") === "%PDF-";
  if (ct === "image/webp") return buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

export async function POST(req: Request) {
  const g = await gateOrResponse(["OPERATOR", "SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;

  let fd: FormData;
  try { fd = await req.formData(); } catch { return NextResponse.json({ error: "multipart form required" }, { status: 400 }); }
  const orderRef = String(fd.get("order_id") ?? fd.get("order_ref") ?? "");
  const kind = String(fd.get("kind") ?? "screenshot");
  const file = fd.get("file");
  if (!orderRef) return NextResponse.json({ error: "order_id required" }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "file too large (max 8MB)" }, { status: 413 });
  const ct = file.type || "application/octet-stream";
  if (!ALLOWED.includes(ct)) return NextResponse.json({ error: `content-type ${ct} not allowed` }, { status: 415 });

  try {
    const o = (await rows<any>("fifo", `SELECT id::text, status FROM fifo_orders WHERE order_ref=$1 OR id::text=$1 LIMIT 1`, [orderRef]))[0];
    if (!o) return NextResponse.json({ error: "order not found" }, { status: 404 });

    const buf = Buffer.from(await file.arrayBuffer());

    // Content scan (SEC-007): verify the file's magic bytes match its declared
    // type so a malicious payload can't masquerade as an allowed image/PDF.
    if (!magicMatches(buf, ct)) {
      return NextResponse.json({ error: "file content does not match its type (failed scan)" }, { status: 415 });
    }

    const sha = createHash("sha256").update(buf).digest("hex");
    const ext = ct === "application/pdf" ? "pdf" : (ct.split("/")[1] || "bin");
    const dir = path.join(STORE, o.id);
    await mkdir(dir, { recursive: true });
    const storageRef = path.join(dir, `${sha.slice(0, 16)}_${randomBytes(4).toString("hex")}.${ext}`);
    await writeFile(storageRef, buf, { mode: 0o600 });

    const p = (await rows<{ id: string }>("fifo", `
      INSERT INTO fifo_order_proofs (order_id, kind, filename, content_type, size_bytes, sha256, storage_ref, uploaded_by, scan_status)
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, 'CLEAN') RETURNING id::text
    `, [o.id, kind, file.name || null, ct, buf.length, sha, storageRef, s.email]))[0];

    let status = o.status;
    if (o.status === "PROCESSING") {
      await transition({ orderId: o.id, to: "PROOF_UPLOADED", actor: s.email, actorKind: "operator", reason: "proof uploaded", payload: { sha256: sha, kind } });
      status = "PROOF_UPLOADED";
    }
    return NextResponse.json({ ok: true, proof_id: p.id, sha256: sha, status });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
