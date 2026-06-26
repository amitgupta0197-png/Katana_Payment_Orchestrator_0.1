// Persona policy (PRODUCT_VISION §3.3):
//   SUPER_ADMIN — U ✓ all fields.
//   PROVIDER    — U KYC + bank only (subset).
//   MERCHANT    — U contact + webhook URL only (subset).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  contact_email: z.string().email().optional(),
  contact_phone: z.string().optional(),
  webhook_url: z.string().url().optional().or(z.literal("")),
  return_url: z.string().url().optional().or(z.literal("")),
  stage: z.string().optional(),
  risk_tier: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  let body;
  try { body = updateSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  // Persona-restricted field allowlists.
  const allowed = s.persona === "SUPER_ADMIN"
    ? new Set(Object.keys(updateSchema.shape))
    : s.persona === "PROVIDER"
      ? new Set(["risk_tier"]) // KYC + bank are tracked in their own tables; expose later.
      : new Set(["contact_email", "contact_phone", "webhook_url", "return_url"]);
  const fields = Object.fromEntries(
    Object.entries(body).filter(([k, v]) => allowed.has(k) && v !== undefined),
  );
  if (Object.keys(fields).length === 0)
    return NextResponse.json({ error: "no fields you may edit were supplied" }, { status: 400 });

  // Scope check.
  if (s.persona === "MERCHANT" && s.scope_id !== id)
    return NextResponse.json({ error: "merchants can only edit own row" }, { status: 403 });
  if (s.persona === "PROVIDER") {
    const codes = await resolveProviderMerchants(s); // returns merchant_codes
    const m = await rows<{ merchant_code: string }>("merchant", `SELECT merchant_code FROM merchants WHERE id = $1::uuid`, [id]);
    if (!m.length || !codes.includes(m[0].merchant_code))
      return NextResponse.json({ error: "merchant not mapped to your provider" }, { status: 403 });
  }

  try {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      args.push(v);
      sets.push(`${k} = $${args.length}`);
    }
    args.push(id);
    const res = await rows<any>("merchant", `
      UPDATE merchants SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $${args.length}::uuid
       RETURNING id, merchant_code, contact_email, contact_phone, stage, risk_tier
    `, args);
    if (!res.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    await rows("merchant", `
      INSERT INTO merchant_activity (merchant_id, action, actor, payload)
      VALUES ($1::uuid, 'PROFILE_UPDATED', $2, $3::jsonb)
    `, [id, s.email, JSON.stringify(fields)]).catch(() => {});
    return NextResponse.json(res[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
