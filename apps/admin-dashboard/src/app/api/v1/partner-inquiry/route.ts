// POST /api/v1/partner-inquiry — public "Become a Katana Partner" / contact-us form on
// the marketing landing. Anyone can submit (no session); stored in merchant db and shown
// to admins at /partner-inquiries. Whitelisted in middleware PUBLIC_API. Kept deliberately
// permissive (public form) but length-capped and lightly validated to bound abuse.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().trim().min(1, "name required").max(120),
  email: z.string().trim().email("valid email required").max(160),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  company: z.string().trim().max(160).optional().or(z.literal("")),
  partner_type: z.string().trim().max(60).optional().or(z.literal("")),
  message: z.string().trim().max(4000).optional().or(z.literal("")),
  // Honeypot: hidden from humans, so a real user leaves it empty; bots fill every field.
  // Accepts any value at the schema level so a tripped honeypot doesn't 400 (which would
  // leak the mechanism) — the handler silently accepts and drops it instead.
  website: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  let body;
  try { body = schema.parse(await req.json()); }
  catch (e) {
    const msg = e instanceof z.ZodError ? e.issues[0]?.message ?? "invalid input" : "bad json";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // Honeypot tripped — pretend success so bots don't retry, but store nothing.
  if (body.website) return NextResponse.json({ ok: true });

  try {
    await rows("merchant", `
      INSERT INTO partner_inquiries (name, email, phone, company, partner_type, message, source)
      VALUES ($1, $2, $3, $4, $5, $6, 'landing')
    `, [
      body.name,
      body.email,
      body.phone || null,
      body.company || null,
      body.partner_type || null,
      body.message || null,
    ]);
    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
