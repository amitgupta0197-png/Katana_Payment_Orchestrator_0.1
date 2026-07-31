// /api/providers/[id]/vendors/[vid]/docs — supporting documents for a vendor
// (cancelled cheque, GST certificate, agreement…). Same hardening as KYC uploads.
//   GET  — list.  POST — upload (multipart: doc_type, file).  SUPER_ADMIN + PROVIDER(own).

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { createHash, randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

const STORE = process.env.VENDOR_DOC_STORE ?? "/opt/katana/vendor-doc-store";
const ALLOWED = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
const MAX_BYTES = 12 * 1024 * 1024;
const DOC_TYPES = ["CANCELLED_CHEQUE", "GST_CERT", "PAN_CARD", "AGREEMENT", "INVOICE", "OTHER"];

function magicMatches(buf: Buffer, ct: string): boolean {
  if (buf.length < 12) return false;
  if (ct === "image/png") return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (ct === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ct === "application/pdf") return buf.subarray(0, 5).toString("latin1") === "%PDF-";
  if (ct === "image/webp") return buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

async function guard(session: { persona: string; scope_id: string | null }, id: string, vid: string) {
  if (session.persona === "PROVIDER" && session.scope_id !== id)
    return NextResponse.json({ error: "providers can only manage their own vendors" }, { status: 403 });
  const v = await rows<{ id: string }>("provider",
    `SELECT id::text FROM provider_vendors WHERE id = $1::uuid AND provider_id = $2::uuid`, [vid, id]).catch(() => []);
  if (!v.length) return NextResponse.json({ error: "vendor not found" }, { status: 404 });
  return null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; vid: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id, vid } = await params;
  const denied = await guard(g.session, id, vid);
  if (denied) return denied;
  try {
    const docs = await rows("provider", `
      SELECT id::text, doc_type, sha256, uploaded_by, created_at
        FROM provider_vendor_documents WHERE vendor_id = $1::uuid ORDER BY created_at DESC
    `, [vid]);
    return NextResponse.json({ documents: docs, doc_types: DOC_TYPES });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string; vid: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id, vid } = await params;
  const denied = await guard(s, id, vid);
  if (denied) return denied;

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
    const buf = Buffer.from(await file.arrayBuffer());
    if (!magicMatches(buf, ct))
      return NextResponse.json({ error: "file content does not match its type (failed scan)" }, { status: 415 });

    const sha = createHash("sha256").update(buf).digest("hex");
    const ext = ct === "application/pdf" ? "pdf" : (ct.split("/")[1] || "bin");
    const dir = path.join(STORE, vid);
    await mkdir(dir, { recursive: true });
    const storageRef = path.join(dir, `${docType}_${sha.slice(0, 16)}_${randomBytes(4).toString("hex")}.${ext}`);
    await writeFile(storageRef, buf, { mode: 0o600 });

    const ins = await rows<{ id: string }>("provider", `
      INSERT INTO provider_vendor_documents (vendor_id, doc_type, uri, sha256, uploaded_by)
      VALUES ($1::uuid, $2, $3, $4, $5)
      ON CONFLICT (vendor_id, sha256) DO NOTHING
      RETURNING id::text
    `, [vid, docType, storageRef, sha, s.email]);
    if (!ins.length)
      return NextResponse.json({ error: "this exact file was already uploaded for this vendor" }, { status: 409 });

    return NextResponse.json({ ok: true, document_id: ins[0].id });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
