// /api/providers/[id]/kyc-docs
//   GET  — list KYC documents uploaded for a provider.
//   POST — upload a KYC document (multipart: doc_type, file).
// Hardened like the merchant KYB / FIFO proof uploads: type allow-list, size cap,
// magic-byte content scan, SHA-256 hash, stored outside the public web root.
//
//   SUPER_ADMIN: full read + upload.
//   PROVIDER:    read + upload OWN only (so a provider can submit its own KYC).
//
// Verifying a document (and thus letting KYC be approved) is a separate
// SUPER_ADMIN action — see ./[docId] PATCH.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { createHash, randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

const STORE = process.env.PROVIDER_KYC_STORE ?? "/opt/katana/provider-kyc-store"; // outside public root
const ALLOWED = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
const MAX_BYTES = 12 * 1024 * 1024;
const DOC_TYPES = ["PAN", "GST", "CIN", "MOA", "AOA", "BOARD_RESOLUTION", "ADDRESS_PROOF", "BANK_STATEMENT", "OTHER"];

function magicMatches(buf: Buffer, ct: string): boolean {
  if (buf.length < 12) return false;
  if (ct === "image/png") return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (ct === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ct === "application/pdf") return buf.subarray(0, 5).toString("latin1") === "%PDF-";
  if (ct === "image/webp") return buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

// PROVIDER may only act on its own provider row.
function scopeDenied(session: any, id: string): NextResponse | null {
  if (session.persona === "PROVIDER" && session.scope_id !== id)
    return NextResponse.json({ error: "providers can only manage their own KYC docs" }, { status: 403 });
  return null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const denied = scopeDenied(g.session, id);
  if (denied) return denied;
  try {
    const docs = await rows<any>("provider", `
      SELECT id::text, doc_type, uri, sha256,
             COALESCE(verified_at::text,'') AS verified_at,
             COALESCE(verified_by,'') AS verified_by, created_at
        FROM provider_kyc_documents WHERE provider_id = $1::uuid ORDER BY created_at DESC
    `, [id]);
    return NextResponse.json({ documents: docs, doc_types: DOC_TYPES });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;
  const denied = scopeDenied(s, id);
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
    const exists = await rows<{ id: string }>("provider", `SELECT id::text FROM providers WHERE id = $1::uuid`, [id]).catch(() => []);
    if (!exists.length) return NextResponse.json({ error: "provider not found" }, { status: 404 });

    const buf = Buffer.from(await file.arrayBuffer());
    if (!magicMatches(buf, ct))
      return NextResponse.json({ error: "file content does not match its type (failed scan)" }, { status: 415 });

    const sha = createHash("sha256").update(buf).digest("hex");
    const ext = ct === "application/pdf" ? "pdf" : (ct.split("/")[1] || "bin");
    const dir = path.join(STORE, id);
    await mkdir(dir, { recursive: true });
    const storageRef = path.join(dir, `${docType}_${sha.slice(0, 16)}_${randomBytes(4).toString("hex")}.${ext}`);
    await writeFile(storageRef, buf, { mode: 0o600 });

    // provider_kyc_documents is UNIQUE(provider_id, sha256): the same exact file
    // can't be uploaded twice. Surface that as a friendly 409 rather than a 500.
    const ins = await rows<{ id: string }>("provider", `
      INSERT INTO provider_kyc_documents (provider_id, doc_type, uri, sha256)
      VALUES ($1::uuid, $2, $3, $4)
      ON CONFLICT (provider_id, sha256) DO NOTHING
      RETURNING id::text
    `, [id, docType, storageRef, sha]);
    if (!ins.length)
      return NextResponse.json({ error: "this exact file was already uploaded for this provider" }, { status: 409 });

    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
      VALUES ($1::uuid, $2, $3, $4::jsonb)
    `, [id, s.email, "provider.kyc_doc.uploaded", JSON.stringify({ doc_type: docType, sha256: sha })]).catch(() => {});

    return NextResponse.json({ ok: true, document_id: ins[0].id, doc_type: docType, sha256: sha });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
