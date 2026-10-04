// /api/settlements/outstanding?provider=<id>&branch=<merchant_code>
// Outstanding receivable for a (provider, branch): collected SUCCESS pay-ins minus
// already-verified settlements. Prefills the "raise settlement" amount.
// `by_channel` carries the same per pay-in channel; with ?channel=INTENT|P2P the top-level
// figures are that channel's (a settlement raised for one channel covers only its pay-ins).
//   SUPER_ADMIN + PROVIDER(own).

import { NextResponse } from "next/server";
import { pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { outstandingByChannel, outstandingForBranch } from "@/lib/branch-settlement";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);
  const branch = url.searchParams.get("branch");
  const providerId = s.persona === "PROVIDER" ? s.scope_id! : url.searchParams.get("provider");
  if (!providerId || !branch) return NextResponse.json({ error: "merchant and banker required" }, { status: 400 });

  try {
    const channel = url.searchParams.get("channel")?.toUpperCase();
    const [o, byChannel] = await Promise.all([outstandingForBranch(providerId, branch), outstandingByChannel(providerId, branch)]);
    const top = channel === "INTENT" || channel === "P2P" ? byChannel[channel] : o;
    return NextResponse.json({ provider_id: providerId, branch, channel: top === o ? null : channel, ...top, by_channel: byChannel });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
