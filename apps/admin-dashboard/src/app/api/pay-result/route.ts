// Public landing page Katana forwards the customer to after a hosted-gateway
// payment (used as surl/furl by the no-PHP test page). Renders the status from
// the query string. Allow-listed in middleware.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const status = u.searchParams.get("status") ?? "-";
  const txnid = u.searchParams.get("txnid") ?? "-";
  const error = u.searchParams.get("error") ?? "";
  const ok = status.toUpperCase() === "SUCCESS";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Payment ${esc(status)}</title></head>
<body style="font-family:sans-serif;max-width:640px;margin:48px auto">
  <h2 style="color:${ok ? "#0a7d2c" : "#b00020"}">Payment ${esc(status)}</h2>
  <p>Transaction: <code>${esc(txnid)}</code></p>
  ${error ? `<p style="color:#b00020">Note: ${esc(error)}</p>` : ""}
  <p><a href="https://glhouse.shop/">Open Katana dashboard</a></p>
</body></html>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
