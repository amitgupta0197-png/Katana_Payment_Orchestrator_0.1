// GET /api/merchants/{id}/headless — quasi-headless setup for one banker (lib/headless): its
// PhonePe / Paytm PG accounts saved for P2P (any environment), which of them a live order may use,
// and where each stands on its go-live checklist. SUPER_ADMIN only, like every processor account;
// no credential is returned. Accounts are saved through POST …/gateway-mid with channel P2P.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { bankerGatewayAccounts } from "@/lib/mid-switch-store";
import { getGatewayMid, VAULT_LABEL } from "@/lib/gateway-creds";
import { gatewayAccountChannel } from "@/lib/pg-catalog";
import { payinProdEnabled, payinWebhookUrl } from "@/lib/payin-providers/types";
import { getGoLive } from "@/lib/gateway-golive";
import { headlessAccounts } from "@/lib/headless-store";
import { asHeadlessPsp, HEADLESS_PSPS } from "@/lib/headless";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const m = await rows<{ merchant_code: string }>("merchant", `SELECT merchant_code FROM merchants WHERE id = $1::uuid`, [(await params).id]);
    const code = m[0]?.merchant_code;
    if (!code) return NextResponse.json({ error: "banker not found" }, { status: 404 });
    const all = await bankerGatewayAccounts(code).catch(() => []);
    const accounts = [];
    for (const a of all) {
      const psp = asHeadlessPsp(a.gateway);
      if (!psp) continue;
      const mid = await getGatewayMid(code, a.vault_label).catch(() => null);
      if (!mid || gatewayAccountChannel(mid) !== "P2P") continue;
      accounts.push({
        psp, vault_label: a.vault_label, account: a.vault_label === VAULT_LABEL ? "main" : "extra", env: mid.env ?? "TEST",
        golive: mid.env === "PROD" ? (await getGoLive(code, a.gateway, a.vault_label).catch(() => null))?.status ?? null : null,
      });
    }
    const live = (await headlessAccounts(code, true)).map((a) => a.psp);
    return NextResponse.json({
      banker: code, accounts, live_psps: live,
      // Whether the banker's first account is taken (by any gateway): a new PSP account then goes beside it.
      main_used: all.some((a) => a.vault_label === VAULT_LABEL),
      switched_on: Object.fromEntries(HEADLESS_PSPS.map((p) => [p, payinProdEnabled(p)])),
      webhook_urls: Object.fromEntries(HEADLESS_PSPS.map((p) => [p, payinWebhookUrl(p)])),
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
