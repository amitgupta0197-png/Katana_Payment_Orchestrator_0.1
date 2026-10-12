// POST /api/pay-status/{id}/start  { psp: "PHONEPE" | "PAYTM" }
//
// PUBLIC (the order id in the URL is the capability, like the pay page; under the
// /api/pay-status prefix the middleware lets through). The Pay button of Katana's hosted
// checkout for a quasi-headless order (lib/headless, lib/headless-store): asks the chosen app's
// PSP — the banker's own account — for the UPI intent the first time, and answers the app link to
// fire. A second tap gets the same link. Customer-facing: no gateway, no account, no PSP error text.

import { NextResponse } from "next/server";
import { HeadlessStartError, startHeadlessPayment } from "@/lib/headless-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "This payment was not found.", code: "NOT_FOUND" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "127.0.0.1";
  try {
    const r = await startHeadlessPayment(id, body?.psp, { ip, deviceInfo: req.headers.get("user-agent") ?? "Mozilla/5.0" });
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof HeadlessStartError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    console.error("[headless] start", id, err);
    return NextResponse.json({ error: "Couldn't start the payment. Try again.", code: "START_FAILED" }, { status: 502 });
  }
}
