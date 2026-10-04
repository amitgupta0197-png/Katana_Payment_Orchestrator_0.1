// /api/tsps/{id}/documents/{docId}
//   GET    the file, for review (staff)
//   PATCH  { decision: "APPROVED" | "REJECTED", note? } — by someone other than the uploader

import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { gateOrResponse } from "@/lib/scope";
import { CHAIN_READ, CHAIN_REVIEW, reviewTspDocument, tspDocumentFile } from "@/lib/chain-store";
import { chainErrorResponse, jsonBody, UUID_RE } from "@/lib/chain-http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const g = await gateOrResponse(CHAIN_READ);
  if ("response" in g) return g.response;
  const { id, docId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(docId)) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const f = await tspDocumentFile(id, docId);
    if (!f) return NextResponse.json({ error: "not found" }, { status: 404 });
    const buf = await readFile(f.storage_ref).catch(() => null);
    if (!buf) return NextResponse.json({ error: "the file is not on this server" }, { status: 410 });
    const name = (f.filename ?? "document").replace(/[^\w.\-]/g, "_");
    return new NextResponse(new Uint8Array(buf), { headers: {
      "Content-Type": f.content_type, "Content-Disposition": `inline; filename="${name}"`,
      "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
    } });
  } catch (e) { return chainErrorResponse(e); }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const g = await gateOrResponse(CHAIN_REVIEW);
  if ("response" in g) return g.response;
  const { id, docId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(docId)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const b = await jsonBody(req);
  if (b?.decision !== "APPROVED" && b?.decision !== "REJECTED") return NextResponse.json({ error: "decision must be APPROVED or REJECTED" }, { status: 400 });
  try {
    await reviewTspDocument(id, docId, b.decision, typeof b.note === "string" ? b.note : null, { id: g.session.user_id, email: g.session.email });
    return NextResponse.json({ ok: true });
  } catch (e) { return chainErrorResponse(e); }
}
