// POST /api/tsps/{id}/documents — upload a TSP's KYB document (multipart: doc_type, file).
// Hardened like the banker KYB upload: type allow-list, 12 MB cap, magic-byte check, SHA-256,
// stored outside the public web root. The list comes with GET /api/tsps/{id}.

import { NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { gateOrResponse } from "@/lib/scope";
import { addTspDocument, CHAIN_REVIEW, getTsp, TSP_DOC_STORE } from "@/lib/chain-store";
import { TSP_DOC_TYPES } from "@/lib/chain";
import { chainErrorResponse, UUID_RE } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

const ALLOWED = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
const MAX_BYTES = 12 * 1024 * 1024;

function magicMatches(buf: Buffer, ct: string): boolean {
  if (buf.length < 12) return false;
  if (ct === "image/png") return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (ct === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ct === "application/pdf") return buf.subarray(0, 5).toString("latin1") === "%PDF-";
  if (ct === "image/webp") return buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(CHAIN_REVIEW);
  if ("response" in g) return g.response;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "TSP not found" }, { status: 404 });
  let fd: FormData;
  try { fd = await req.formData(); } catch { return NextResponse.json({ error: "multipart form required" }, { status: 400 }); }
  const docType = String(fd.get("doc_type") ?? "").toUpperCase();
  const file = fd.get("file");
  if (!(TSP_DOC_TYPES as readonly string[]).includes(docType))
    return NextResponse.json({ error: `doc_type must be one of ${TSP_DOC_TYPES.join(", ")}` }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "file too large (max 12MB)" }, { status: 413 });
  const ct = file.type || "application/octet-stream";
  if (!ALLOWED.includes(ct)) return NextResponse.json({ error: `content-type ${ct} not allowed (PNG/JPEG/WEBP/PDF only)` }, { status: 415 });
  try {
    if (!(await getTsp(id))) return NextResponse.json({ error: "TSP not found" }, { status: 404 });
    const buf = Buffer.from(await file.arrayBuffer());
    if (!magicMatches(buf, ct)) return NextResponse.json({ error: "file content does not match its type (failed scan)" }, { status: 415 });
    const sha = createHash("sha256").update(buf).digest("hex");
    const ext = ct === "application/pdf" ? "pdf" : (ct.split("/")[1] || "bin");
    const dir = path.join(TSP_DOC_STORE, "tsp", id);
    await mkdir(dir, { recursive: true });
    const storageRef = path.join(dir, `${docType}_${sha.slice(0, 16)}_${randomBytes(4).toString("hex")}.${ext}`);
    await writeFile(storageRef, buf, { mode: 0o600 });
    const doc = await addTspDocument(id, { doc_type: docType, filename: file.name || null, content_type: ct, size_bytes: buf.length, sha256: sha, storage_ref: storageRef },
      { id: g.session.user_id, email: g.session.email });
    return NextResponse.json({ ok: true, document_id: doc.id, sha256: sha }, { status: 201 });
  } catch (e) { return chainErrorResponse(e); }
}
