// GET /api/merchants/[id]/starter-kit?format=whatsapp|telegram|plain&length=short|full — a banker's Starter Kit
// (lib/starter-kit): chat messages to paste into WhatsApp or Telegram, written from what the
// banker was set up for, with its test Key + Salt in full and its live Key without the Salt.
//
//   SUPER_ADMIN  any banker
//   PROVIDER     the bankers mapped under it (the merchant portal)
//
// The banker itself does not get it from here: its Integration page already shows its keys.
//
// A banker with no test pair is given one here, so the kit always carries working test keys.
// Only a missing pair is made; an existing one is never replaced.

import { NextResponse } from "next/server";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { resolveMerchantScope } from "@/lib/merchant-keys";
import { getCheckoutCreds, issueCheckoutCreds } from "@/lib/merchant-checkout";
import { buildStarterKit, KIT_FORMATS, KIT_LENGTHS, type KitFormat, type KitLength } from "@/lib/starter-kit";
import { starterKitFacts } from "@/lib/starter-kit-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const { id } = await params;
  const scope = await resolveMerchantScope(id, g.session);
  if ("response" in scope) return scope.response;

  const asked = new URL(req.url).searchParams.get("format") ?? "whatsapp";
  const format: KitFormat = (KIT_FORMATS as readonly string[]).includes(asked) ? (asked as KitFormat) : "whatsapp";
  // Short (one message) unless the whole guide is asked for.
  const askedLen = new URL(req.url).searchParams.get("length") ?? "short";
  const length: KitLength = (KIT_LENGTHS as readonly string[]).includes(askedLen) ? (askedLen as KitLength) : "short";

  try {
    let issuedTestKeys = false;
    if (!(await getCheckoutCreds(scope.code, false))) {
      await issueCheckoutCreds(scope.code, "HMAC_SHA256", false);
      issuedTestKeys = true;
      await rows("merchant", `
        INSERT INTO merchant_activity (merchant_id, action, actor, payload)
        VALUES ($1::uuid, 'TEST_KEYS_ISSUED', $2, $3::jsonb)
      `, [id, g.session.email, JSON.stringify({ reason: "starter kit" })]).catch(() => {});
    }
    const kit = buildStarterKit(await starterKitFacts(scope.code), format, length);
    // The kit carries a test Salt: never cached on the way.
    return NextResponse.json({ merchant_code: scope.code, issued_test_keys: issuedTestKeys, ...kit },
      { headers: { "Cache-Control": "no-store" } });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
