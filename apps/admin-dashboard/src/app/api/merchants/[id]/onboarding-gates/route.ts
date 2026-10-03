// GET /api/merchants/[id]/onboarding-gates — a banker's KYB identifiers, the system's gate
// results (lib/onboarding-gates, newest first) and the history of its stage.
// Staff and the merchant it belongs to; never the banker itself.
import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";
import { listGates, requiredDocuments, strictOnboarding } from "@/lib/onboarding-gates";
import { bankerSetup } from "@/lib/merchant-setup";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;
  try {
    const m = (await rows<Record<string, string | null>>("merchant", `
      SELECT gstin, business_pan, director_name, director_pan, director_aadhaar_last4,
             est_monthly_volume::text, category_mcc, website, stage, merchant_code
        FROM merchants WHERE id = $1::uuid`, [id]))[0];
    const history = await rows("merchant", `
      SELECT from_stage, to_stage, changed_at FROM merchant_status_history
       WHERE merchant_id = $1::uuid ORDER BY id DESC LIMIT 30`, [id]);
    return NextResponse.json({
      details: m, gates: await listGates(id), history,
      required_documents: requiredDocuments({ gstin: m.gstin }), strict: strictOnboarding(),
      // What the banker's merchant was onboarded for, and what go-live still needs (the SETUP gate).
      setup: m.merchant_code ? await bankerSetup(m.merchant_code).catch(() => null) : null,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
