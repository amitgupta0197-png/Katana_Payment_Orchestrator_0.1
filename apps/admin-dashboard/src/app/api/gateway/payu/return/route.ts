// PayU surl/furl callback. PayU POSTs the payment result here (set as the
// gateway surl/furl in /api/pay redirect mode). We verify PayU's response hash
// with the merchant's stored PayU salt, finalise the order, enqueue the merchant
// webhook, then forward the customer's browser to the merchant's own URL.
//
// Public (allow-listed in middleware) — authenticated by the PayU response hash.

import { NextResponse } from "next/server";
import { rows } from "@/lib/pg";
import { getGatewayMid } from "@/lib/gateway-creds";
import { payuResponseHash } from "@/lib/payu";
import { enqueue as enqueueWebhook } from "@/lib/webhook-outbox";

export const dynamic = "force-dynamic";

async function parseBody(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return await req.json();
  const fd = await req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) out[k] = typeof v === "string" ? v : "";
  return out;
}

function redirectTo(dest: string | null, base: string, params: Record<string, string>): NextResponse {
  let u: URL;
  try { u = new URL(dest || `${base}/`); } catch { u = new URL(`${base}/`); }
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return NextResponse.redirect(u.toString(), 303);
}

export async function POST(req: Request) {
  const base = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
  let p: Record<string, string>;
  try { p = await parseBody(req); } catch { return new NextResponse("bad request", { status: 400 }); }

  const txnid = p.txnid || p.txnId || "";
  const payuStatus = (p.status || "").toLowerCase();
  if (!txnid) return new NextResponse("missing txnid", { status: 400 });

  const o = (await rows<any>("checkout",
    `SELECT id, merchant_id, status, client_surl, client_furl FROM checkout_orders WHERE txn_id = $1 LIMIT 1`,
    [txnid]).catch(() => []))[0];
  if (!o) return redirectTo(null, base, { txnid, status: "UNKNOWN", error: "unknown_txn" });

  // Verify PayU's response hash with the merchant's stored PayU salt.
  const gwMid = await getGatewayMid(o.merchant_id);
  const expected = gwMid ? payuResponseHash(gwMid, {
    status: p.status || "", email: p.email || "", firstname: p.firstname || "",
    productinfo: p.productinfo || "", amount: p.amount || "", txnid,
    additionalCharges: p.additionalCharges,
  }) : "";
  const hashOk = !!gwMid && !!p.hash && expected.toLowerCase() === p.hash.toLowerCase();

  const success = payuStatus === "success" && hashOk;
  const nextStatus = success ? "SUCCESS" : "FAILED";

  if (o.status !== "SUCCESS" && o.status !== "FAILED") {
    await rows("checkout", `UPDATE checkout_orders SET status=$1 WHERE id=$2::uuid`, [nextStatus, o.id]).catch(() => {});
    await rows("checkout", `
      INSERT INTO order_state_transitions (order_id, from_status, to_status, actor_kind, reason, payload)
      VALUES ($1::uuid, $2, $3, 'gateway', $4, $5::jsonb)
    `, [o.id, o.status, nextStatus, hashOk ? `payu ${payuStatus}` : "payu hash mismatch",
        JSON.stringify({ payu_status: p.status, mihpayid: p.mihpayid, mode: p.mode, hash_ok: hashOk })]).catch(() => {});
    await enqueueWebhook({
      merchantId: o.merchant_id, orderId: o.id,
      eventType: success ? "payment.success" : "payment.failed",
      payload: { txn_id: txnid, provider: "PAYU", status: nextStatus,
                 amount: p.amount ?? null, mihpayid: p.mihpayid ?? null, hash_verified: hashOk },
    }).catch(() => null);
  }

  const dest = success ? o.client_surl : o.client_furl;
  return redirectTo(dest, base, { txnid, status: nextStatus, ...(hashOk ? {} : { error: "hash_verification_failed" }) });
}

// Some PayU flows may GET the return URL; send the customer to the app root.
export async function GET() {
  const base = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
  return NextResponse.redirect(`${base}/`, 303);
}
