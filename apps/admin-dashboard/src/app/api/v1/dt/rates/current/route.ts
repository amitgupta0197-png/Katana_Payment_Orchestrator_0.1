// GET /api/v1/dt/rates/current — current DT rate card.
// POST — set a new rate (Katana-controlled; supersedes previous, versioned). SUPER_ADMIN.
import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { currentRate, setRate } from "@/lib/dt";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN", "FINANCE", "RISK"]);
  if ("response" in g) return g.response;
  return NextResponse.json({ rate: await currentRate() });
}

const schema = z.object({ rate: z.number().positive(), currency: z.string().max(8).default("INR") });

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  let body; try { body = schema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  await setRate(body.rate, body.currency, g.session.email);
  return NextResponse.json({ ok: true, rate: await currentRate() });
}
