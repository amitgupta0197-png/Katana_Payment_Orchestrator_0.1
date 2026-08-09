// PayU surl/furl callback. PayU POSTs the payment result here (set as the
// gateway surl/furl in /api/pay redirect mode) as the CUSTOMER'S BROWSER returns.
// We verify PayU's response hash with the merchant's stored PayU salt, finalise the
// order, enqueue the merchant webhook, then forward the browser to the merchant's URL.
//
// The verification + order handling is shared with the server-to-server webhook at
// /api/gateway/payu/webhook (lib/payu-result) so the two channels can never judge the
// same payment differently. The only difference is the reply: a browser needs a
// redirect, a webhook needs a 2xx.
//
// Public (allow-listed in middleware) — authenticated by the PayU response hash.

import { NextResponse } from "next/server";
import { applyPayuResult, parsePayuBody } from "@/lib/payu-result";

export const dynamic = "force-dynamic";

function redirectTo(dest: string | null, base: string, params: Record<string, string>): NextResponse {
  let u: URL;
  try { u = new URL(dest || `${base}/`); } catch { u = new URL(`${base}/`); }
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return NextResponse.redirect(u.toString(), 303);
}

export async function POST(req: Request) {
  const base = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
  let p: Record<string, string>;
  try { p = await parsePayuBody(req); } catch { return new NextResponse("bad request", { status: 400 }); }

  const r = await applyPayuResult(p);
  if (!r.txnid) return new NextResponse("missing txnid", { status: 400 });
  if (!r.matched) return redirectTo(null, base, { txnid: r.txnid, status: "UNKNOWN", error: r.reason ?? "unknown_txn" });

  return redirectTo(r.dest, base, {
    txnid: r.txnid,
    status: r.status,
    ...(r.hashOk ? {} : { error: "hash_verification_failed" }),
  });
}

// Some PayU flows may GET the return URL; send the customer to the app root.
export async function GET() {
  const base = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
  return NextResponse.redirect(`${base}/`, 303);
}
