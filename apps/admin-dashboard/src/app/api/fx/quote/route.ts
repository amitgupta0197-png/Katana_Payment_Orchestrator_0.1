// GET /api/fx/quote?from=INR&to=USD  → latest quote + conversion stub.

import { NextResponse } from "next/server";
import { gateOrResponse } from "@/lib/scope";
import { getQuote, convertMinor } from "@/lib/fx";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN","MERCHANT","PROVIDER"]);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const amount = url.searchParams.get("amount_minor");
  if (!from || !to) return NextResponse.json({ error: "?from and ?to required" }, { status: 400 });
  const quote = await getQuote(from, to);
  if (!quote) return NextResponse.json({ error: "no quote available" }, { status: 404 });
  let conversion: { amount_minor: string; rate: number; spread_bps: number } | null = null;
  if (amount) {
    const c = await convertMinor(amount, from, to);
    if (c) conversion = { amount_minor: c.amount_minor.toString(), rate: c.rate, spread_bps: c.spread_bps };
  }
  return NextResponse.json({ quote, conversion });
}
