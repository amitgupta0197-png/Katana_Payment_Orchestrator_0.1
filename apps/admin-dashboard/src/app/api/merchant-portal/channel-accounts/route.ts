// GET /api/merchant-portal/channel-accounts — the merchant's pay-in accounts per channel for a
// window (lib/channel-accounts): gross, paid / pending / failed, success rate, fees, chargeback
// debits, net, settled / unsettled, reconciliation variance and chargebacks, for INTENT, P2P and
// any unclassified rows, with "total" the sum of them.
//
// ?from=&to= are IST calendar days. ?channel= is accepted and echoed, but every channel is always
// returned: the screen shows the selected one and keeps the others beside it.
//
// PROVIDER (own bankers) and SUPER_ADMIN (every banker).

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { txnWindowFromUrl } from "@/lib/txn-window";
import { getLivemode } from "@/lib/mode";
import { PAYIN_CHANNELS } from "@/lib/payin-channel";
import { channelAccounts, emptyAccount } from "@/lib/channel-accounts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["PROVIDER", "SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  try {
    const scoped = s.persona === "PROVIDER";
    const codes = await resolveProviderMerchants(s);
    const window = { ...txnWindowFromUrl(new URL(req.url), scoped ? codes : null, await getLivemode()), status: null };
    if (scoped && !codes.length) {
      const z = emptyAccount();
      return NextResponse.json({ channels: Object.fromEntries(PAYIN_CHANNELS.map((c) => [c, z])), total: z, settlement_exceptions: [], channel: window.channel ?? null, livemode: window.livemode });
    }
    const acc = await channelAccounts({ window, providerId: scoped ? s.scope_id ?? null : null, extra: scoped ? [] : ["o.merchant_id IS NOT NULL"] });
    return NextResponse.json({
      channels: acc.channels, total: acc.total, settlement_exceptions: acc.settlement_exceptions,
      channel: window.channel ?? null, livemode: window.livemode,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
