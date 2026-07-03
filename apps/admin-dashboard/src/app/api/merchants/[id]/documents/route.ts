// /api/merchants/[id]/documents
//   GET  — list KYB documents uploaded for a merchant.
//   POST — upload a KYB document (multipart: doc_type, file) during onboarding.
// Hardened the same way as the FIFO proof upload: type allow-list, size cap,
// magic-byte content scan, SHA-256 hash, stored outside the public web root.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { createHash, randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

const STORE = process.env.KYB_STORE ?? "/opt/katana/kyb-store";   // outside public root
const ALLOWED = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
const MAX_BYTES = 12 * 1024 * 1024;
const DOC_TYPES = ["PAN", "GST", "CIN", "MOA", "AOA", "BOARD_RESOLUTION", "BANK_STATEMENT", "MCC_DECLARATION", "OTHER"];

function magicMatches(buf: Buffer, ct: string): boolean {
  if (buf.length < 12) return false;
  if (ct === "image/png") return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (ct === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ct === "application/pdf") return buf.subarray(0, 5).toString("latin1") === "%PDF-";
  if (ct === "image/webp") return buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

// Shared scope guard: PROVIDER may only touch merchants mapped to it.
async function loadMerchant(session: any, id: string): Promise<{ ok: true; m: any } | { ok: false; res: NextResponse }> {
  const m = (await rows<any>("merchant", `SELECT id::text, merchant_code, stage FROM merchants WHERE id = $1::uuid LIMIT 1`, [id]))[0];
  if (!m) return { ok: false, res: NextResponse.json({ error: "merchant not found" }, { status: 404 }) };
  if (session.persona === "PROVIDER") {
    const codes = await resolveProviderMerchants(session);
    if (!codes.includes(m.merchant_code))
      return { ok: false, res: NextResponse.json({ error: "merchant not mapped to your provider" }, { status: 403 }) };
  }
  return { ok: true, m };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  try {
    const guard = await loadMerchant(g.session, id);
    if (!guard.ok) return guard.res;
    const docs = await rows<any>("merchant", `
      SELECT id::text, doc_type, filename, content_type, size_bytes::text, sha256, uploaded_by, created_at
        FROM merchant_kyb_documents WHERE merchant_id = $1::uuid ORDER BY created_at DESC
    `, [id]);
    return NextResponse.json({ documents: docs, doc_types: DOC_TYPES });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  let fd: FormData;
  try { fd = await req.formData(); } catch { return NextResponse.json({ error: "multipart form required" }, { status: 400 }); }
  const docType = String(fd.get("doc_type") ?? "OTHER").toUpperCase();
  const file = fd.get("file");
  if (!DOC_TYPES.includes(docType)) return NextResponse.json({ error: `doc_type must be one of ${DOC_TYPES.join(", ")}` }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "file too large (max 12MB)" }, { status: 413 });
  const ct = file.type || "application/octet-stream";
  if (!ALLOWED.includes(ct)) return NextResponse.json({ error: `content-type ${ct} not allowed (PNG/JPEG/WEBP/PDF only)` }, { status: 415 });

  try {
    const guard = await loadMerchant(s, id);
    if (!guard.ok) return guard.res;

    const buf = Buffer.from(await file.arrayBuffer());
    if (!magicMatches(buf, ct))
      return NextResponse.json({ error: "file content does not match its type (failed scan)" }, { status: 415 });

    const sha = createHash("sha256").update(buf).digest("hex");
    const ext = ct === "application/pdf" ? "pdf" : (ct.split("/")[1] || "bin");
    const dir = path.join(STORE, id);
    await mkdir(dir, { recursive: true });
    const storageRef = path.join(dir, `${docType}_${sha.slice(0, 16)}_${randomBytes(4).toString("hex")}.${ext}`);
    await writeFile(storageRef, buf, { mode: 0o600 });

    const doc = (await rows<{ id: string }>("merchant", `
      INSERT INTO merchant_kyb_documents (merchant_id, doc_type, filename, content_type, size_bytes, sha256, storage_ref, uploaded_by, scan_status)
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, 'CLEAN') RETURNING id::text
    `, [id, docType, file.name || null, ct, buf.length, sha, storageRef, s.email]))[0];

    // Audit trail in merchant_activity (same log the onboarding steps write to).
    await rows("merchant", `
      INSERT INTO merchant_activity (merchant_id, action, actor, payload)
      VALUES ($1::uuid, 'KYB_DOC_UPLOADED', $2, $3::jsonb)
    `, [id, s.email, JSON.stringify({ doc_type: docType, filename: file.name, sha256: sha })]).catch(() => {});

    return NextResponse.json({ ok: true, document_id: doc.id, doc_type: docType, sha256: sha });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
