// The gateway go-live checklist (lib/gateway-golive). STAFF ONLY: it names gateways.
//   GET  /api/ops/gateway-golive                                   every account on the checklist
//   POST /api/ops/gateway-golive { merchant_id, gateway, account?, action }  run a check, or set the account live
//        account: the account's vault label (default the banker's first, "gateway_mid"); each of a
//        banker's accounts has its own checklist (vendorGateway 0041)
//        action: ping | webhook | status | live   (live also takes `note`)
// Reading is open to staff; running a check or setting an account live is SUPER_ADMIN / ADMIN.

import { NextResponse } from "next/server";
import { z } from "zod";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { STAFF_PERSONAS } from "@/lib/portal-scope";
import { getGatewayMid, VAULT_LABEL } from "@/lib/gateway-creds";
import {
  gatewaySendsWebhooks, goLiveChecklist, canGoLive, getGoLive, listGoLive, recordPing, recordStatusCheck,
  recordWebhookPayment, setLive, VERIFY_MAX_AMOUNT, VERIFY_MAX_ORDERS, type GoLiveRow,
} from "@/lib/gateway-golive";
import { payinWebhookUrl } from "@/lib/payin-providers/types";
import { wormAppend } from "@/lib/worm";

export const dynamic = "force-dynamic";

async function shape(r: GoLiveRow) {
  const mid = await getGatewayMid(r.merchant_id, r.account).catch(() => null);
  const hooks = gatewaySendsWebhooks(r.gateway, mid?.gateway === r.gateway ? mid.auth : null);
  return {
    ...r, account_label: r.account === VAULT_LABEL ? "First account" : `Account ${r.account.slice(VAULT_LABEL.length + 1, VAULT_LABEL.length + 9)}`,
    mid_code: mid?.mid_code ?? null, sends_webhooks: hooks, callback_url: hooks ? payinWebhookUrl(r.gateway) : null,
    credentials_match: mid?.gateway === r.gateway && mid.env === "PROD",
    checklist: goLiveChecklist(r, hooks), can_go_live: r.status === "VERIFYING" && canGoLive(r, hooks),
  };
}

export async function GET() {
  const g = await gateOrResponse(STAFF_PERSONAS);
  if ("response" in g) return g.response;
  try {
    const all = await listGoLive();
    return NextResponse.json({
      accounts: await Promise.all(all.map(shape)),
      limits: { max_amount: VERIFY_MAX_AMOUNT, max_orders: VERIFY_MAX_ORDERS },
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  merchant_id: z.string().min(1).max(120),
  gateway: z.string().min(1).max(40),
  account: z.string().min(1).max(80).default(VAULT_LABEL),
  action: z.enum(["ping", "webhook", "status", "live"]),
  note: z.string().trim().max(300).optional(),
});

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "ADMIN"]);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const by = g.session.email;
  try {
    const acct = body.account;
    const cur = await getGoLive(body.merchant_id, body.gateway, acct);
    if (!cur) return NextResponse.json({ error: "not found" }, { status: 404 });
    const mid = await getGatewayMid(body.merchant_id, acct).catch(() => null);
    const hooks = gatewaySendsWebhooks(body.gateway, mid?.gateway === body.gateway ? mid.auth : null);

    let row: GoLiveRow | null = cur, answer: string | undefined;
    if (body.action === "ping") row = await recordPing(body.merchant_id, body.gateway, by, acct);
    else if (body.action === "webhook") {
      row = await recordWebhookPayment(body.merchant_id, body.gateway, by, hooks, acct);
      if (!row?.webhook_at) answer = hooks ? "no payment confirmed by the gateway's webhook yet" : "no paid live order on this account yet";
    } else if (body.action === "status") ({ row, answer } = await recordStatusCheck(body.merchant_id, body.gateway, by, acct));
    else {
      const r = await setLive(body.merchant_id, body.gateway, by, body.note ?? null, hooks, acct);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
      row = r.row;
    }
    await wormAppend({
      actorId: g.session.user_id, actorEmail: by, action: `gateway.golive.${body.action}`,
      resourceType: "gateway_account", resourceId: `${body.merchant_id}:${body.gateway}:${acct}`,
      after: row ? { status: row.status, ping_ok: row.ping_ok, webhook_at: row.webhook_at, status_at: row.status_at } : null, notes: body.note,
    }).catch(() => null);
    return NextResponse.json({ account: row ? await shape(row) : null, ...(answer ? { answer } : {}) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
