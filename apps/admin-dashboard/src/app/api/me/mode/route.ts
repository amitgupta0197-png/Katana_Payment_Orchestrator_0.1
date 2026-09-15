// /api/me/mode — the signed-in user's dashboard Test / Live switch (see lib/mode.ts).
//   GET  → { livemode }
//   POST { livemode: boolean } → sets the choice; live clears the cookie, test sets it.
//
// The switch only changes what this user SEES and which mode their dashboard-created orders
// use. It carries no authority over money: statements, settlement and reconciliation ignore it.

import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { getLivemode, MODE_COOKIE } from "@/lib/mode";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  return NextResponse.json({ livemode: await getLivemode() });
}

const schema = z.object({ livemode: z.boolean() });

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;

  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const res = NextResponse.json({ livemode: body.livemode });
  if (body.livemode) {
    res.cookies.delete(MODE_COOKIE);            // no cookie = live, the default
  } else {
    res.cookies.set(MODE_COOKIE, "test", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return res;
}
