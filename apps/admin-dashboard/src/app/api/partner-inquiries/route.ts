// /api/partner-inquiries — admin view of inbound partner / contact-us submissions from
// the public landing form. GET lists them (newest first); PATCH updates a row's status
// (NEW → CONTACTED → CLOSED) so admins can work the queue. Session-gated (admin roles).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";

export const dynamic = "force-dynamic";
const ROLES = ["SUPER_ADMIN", "ADMIN", "SUPPORT"] as const;

export async function GET() {
  const g = await gateOrResponse([...ROLES]);
  if ("response" in g) return g.response;
  try {
    const inquiries = await rows<any>("merchant", `
      SELECT id, name, email, COALESCE(phone,'') AS phone, COALESCE(company,'') AS company,
             COALESCE(partner_type,'') AS partner_type, COALESCE(message,'') AS message,
             status, source, created_at
        FROM partner_inquiries
       ORDER BY created_at DESC LIMIT 500
    `).catch(() => []);
    const newCount = inquiries.filter((i: any) => i.status === "NEW").length;
    return NextResponse.json({ inquiries, new_count: newCount });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const patchSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["NEW", "CONTACTED", "CLOSED"]),
});

export async function PATCH(req: Request) {
  const g = await gateOrResponse([...ROLES]);
  if ("response" in g) return g.response;
  let body; try { body = patchSchema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  try {
    await rows("merchant", `UPDATE partner_inquiries SET status = $2 WHERE id = $1`, [body.id, body.status]);
    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
