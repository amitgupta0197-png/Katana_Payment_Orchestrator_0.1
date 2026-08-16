// GET /api/merchant-portal/statement — downloadable transaction statement for a provider.
//
// Covers both channels (?channel=ALL|CHECKOUT|VPA) over a chosen period
// (?period=today|yesterday|last_week|last_month|last_fy|custom, with ?from=&to= for custom).
// ?preview=1 returns the JSON summary instead of the file.
//
// PROVIDER only (middleware restricts /api/merchant-portal/* to that persona), scoped to
// the provider's own bankers.

import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { statementResponse } from "@/lib/statement-route";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["PROVIDER"]);
  if ("response" in g) return g.response;

  const codes = await resolveProviderMerchants(g.session);
  return statementResponse(req, codes);
}
