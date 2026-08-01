// /api/settlements/[id]/receipt — payment evidence on a settlement (bank receipt or
// USDT transfer proof screenshot).
//   POST — upload (multipart: file). DOWNLINE (own branch) + SUPER_ADMIN. Hardened like
//          the KYC upload: type allow-list, size cap, magic-byte scan, SHA-256, stored
//          outside the public web root. Sets receipt_uri and appends a timeline event.
//   GET  — download/stream the stored receipt. UPLINE (own) + DOWNLINE (own) + ADMIN.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { branchKeysForMerchant } from "@/lib/provider-integration";
import { createHash, randomBytes } from "crypto";
import { mkdir, writeFile, readFile } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

const STORE = process.env.SETTLEMENT_PROOF_STORE ?? "/opt/katana/settlement-proof-store";
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

async function loadScoped(id: string, s: { persona: string; scope_id: string | null }) {
  const cur = (await rows<{ id: string; provider_id: string; merchant_key: string; status: string; receipt_uri: string | null; request_ref: string | null }>(
    "provider",
    `SELECT id::text, provider_id::text, merchant_key, status, receipt_uri, request_ref
       FROM provider_branch_settlements WHERE id = $1::uuid`, [id]))[0];
  if (!cur) return { error: NextResponse.json({ error: "settlement not found" }, { status: 404 }) };
  if (s.persona === "PROVIDER" && s.scope_id !== cur.provider_id)
    return { error: NextResponse.json({ error: "not your settlement" }, { status: 403 }) };
  if (s.persona === "MERCHANT") {
    const keys = await branchKeysForMerchant(s.scope_id!);
    if (!keys.includes(cur.merchant_key))
      return { error: NextResponse.json({ error: "not your settlement" }, { status: 403 }) };
  }
  return { cur };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  let fd: FormData;
  try { fd = await req.formData(); } catch { return NextResponse.json({ error: "multipart form required" }, { status: 400 }); }
  const file = fd.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "file too large (max 12MB)" }, { status: 413 });
  const ct = file.type || "application/octet-stream";
  if (!ALLOWED.includes(ct)) return NextResponse.json({ error: `content-type ${ct} not allowed (PNG/JPEG/WEBP/PDF only)` }, { status: 415 });

  try {
    const r = await loadScoped(id, s);
    if ("error" in r) return r.error;
    const cur = r.cur!;

    const buf = Buffer.from(await file.arrayBuffer());
    if (!magicMatches(buf, ct))
      return NextResponse.json({ error: "file content does not match its type (failed scan)" }, { status: 415 });

    const sha = createHash("sha256").update(buf).digest("hex");
    const ext = ct === "application/pdf" ? "pdf" : (ct.split("/")[1] || "bin");
    const dir = path.join(STORE, id);
    await mkdir(dir, { recursive: true });
    const storageRef = path.join(dir, `receipt_${sha.slice(0, 16)}_${randomBytes(4).toString("hex")}.${ext}`);
    await writeFile(storageRef, buf, { mode: 0o600 });

    await rows("provider", `
      UPDATE provider_branch_settlements
         SET receipt_uri = $2, details = details || $3::jsonb, updated_at = now()
       WHERE id = $1::uuid
    `, [id, storageRef, JSON.stringify({ receipt_sha256: sha, receipt_uploaded_by: s.email })]);

    // Evidence is part of the immutable trail (BRD §10.7): status unchanged, event appended.
    await rows("provider", `
      INSERT INTO provider_settlement_events (settlement_id, provider_id, action, from_status, to_status, actor, actor_role, remarks, details)
      VALUES ($1::uuid, $2::uuid, 'UPLOAD_RECEIPT', $3, $3, $4, $5, 'payment receipt uploaded', $6::jsonb)
    `, [id, cur.provider_id, cur.status, s.email, s.persona === "MERCHANT" ? "DOWNLINE" : "ADMIN",
        JSON.stringify({ sha256: sha, content_type: ct })]).catch(() => {});

    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
      VALUES ($1::uuid, $2, 'provider.settlement.receipt_uploaded', $3::jsonb)
    `, [cur.provider_id, s.email, JSON.stringify({ settlement_id: id, ref: cur.request_ref, sha256: sha })]).catch(() => {});

    return NextResponse.json({ ok: true, sha256: sha });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const { id } = await params;

  try {
    const r = await loadScoped(id, g.session);
    if ("error" in r) return r.error;
    const cur = r.cur!;
    if (!cur.receipt_uri) return NextResponse.json({ error: "no receipt uploaded yet" }, { status: 404 });
    // Only serve files from inside the proof store (the column is server-written, but
    // never trust a path blindly).
    const resolved = path.resolve(cur.receipt_uri);
    if (!resolved.startsWith(path.resolve(STORE) + path.sep))
      return NextResponse.json({ error: "receipt path invalid" }, { status: 500 });
    const buf = await readFile(resolved);
    const ext = path.extname(resolved).slice(1);
    const ct = ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": ct,
        "Content-Disposition": `inline; filename="${cur.request_ref ?? id}-receipt.${ext}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
