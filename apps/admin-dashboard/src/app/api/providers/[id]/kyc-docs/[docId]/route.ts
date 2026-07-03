// /api/providers/[id]/kyc-docs/[docId]
//   PATCH  — verify / unverify a KYC document (SUPER_ADMIN). Verifying enough docs
//            is what unlocks "Approve KYC" on the provider.
//   DELETE — remove a wrongly-uploaded document (SUPER_ADMIN).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";

const patchSchema = z.object({ verified: z.boolean() }).strict();

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id, docId } = await params;

  let body;
  try { body = patchSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    const upd = await rows<any>("provider", `
      UPDATE provider_kyc_documents
         SET verified_at = ${body.verified ? "now()" : "NULL"},
             verified_by = ${body.verified ? "$3" : "NULL"}
       WHERE id = $1::uuid AND provider_id = $2::uuid
      RETURNING id::text, doc_type, COALESCE(verified_at::text,'') AS verified_at, COALESCE(verified_by,'') AS verified_by
    `, body.verified ? [docId, id, s.email] : [docId, id]);
    if (!upd.length) return NextResponse.json({ error: "document not found" }, { status: 404 });

    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
      VALUES ($1::uuid, $2, $3, $4::jsonb)
    `, [id, s.email, body.verified ? "provider.kyc_doc.verified" : "provider.kyc_doc.unverified",
        JSON.stringify({ doc_id: docId, doc_type: upd[0].doc_type })]).catch(() => {});

    return NextResponse.json({ document: upd[0] });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id, docId } = await params;
  try {
    const del = await rows<any>("provider", `
      DELETE FROM provider_kyc_documents
       WHERE id = $1::uuid AND provider_id = $2::uuid
      RETURNING id::text, doc_type
    `, [docId, id]);
    if (!del.length) return NextResponse.json({ error: "document not found" }, { status: 404 });
    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
      VALUES ($1::uuid, $2, $3, $4::jsonb)
    `, [id, s.email, "provider.kyc_doc.deleted", JSON.stringify({ doc_id: docId, doc_type: del[0].doc_type })]).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
