// Provider developer settings — integrate Katana Pay into the provider's own website.
// A Katana Pay order always settles to a specific BRANCH, so integration credentials
// are per-branch (the branch's checkout Key + Salt + the order API). This endpoint lets
// a PROVIDER manage those for ANY of their own mapped branches, and read the same
// endpoints/signing docs the merchant integration page uses.
//   PROVIDER only (middleware restricts /api/provider-portal/* to PROVIDER). Every
//   branch is scope-checked against resolveProviderMerchants — a provider can never
//   touch a branch it doesn't own.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { issueCheckoutCreds, getCheckoutCredsStatus } from "@/lib/merchant-checkout";
import { SIGNING_SCHEMES } from "@/lib/gateway-creds";

export const dynamic = "force-dynamic";

const BASE = (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");

function endpoints() {
  return {
    base_url: BASE,
    create_order: `${BASE}/api/v1/katana-pay/order`,
    pay_page: `${BASE}/pay/{order_id}`,
    status_enquiry: `${BASE}/api/pay-status/{order_id}`,
  };
}

// The caller's own branches (code + name), and the selected branch (validated to be one
// of them). Returns null-branch when the provider has no branches yet.
async function scopeBranches(session: Parameters<typeof resolveProviderMerchants>[0], want: string | null) {
  const codes = await resolveProviderMerchants(session);
  if (!codes.length) return { codes: [] as string[], branches: [] as { code: string; name: string }[], branch: null as string | null };
  const named = await rows<{ merchant_code: string; legal_name: string | null }>(
    "merchant",
    `SELECT merchant_code, legal_name FROM merchants WHERE merchant_code = ANY($1::text[]) ORDER BY legal_name NULLS LAST, merchant_code`,
    [codes],
  ).catch(() => []);
  const branches = codes
    .map((c) => ({ code: c, name: named.find((n) => n.merchant_code === c)?.legal_name || c }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const branch = want && codes.includes(want) ? want : branches[0].code;
  return { codes, branches, branch };
}

export async function GET(req: Request) {
  const g = await gateOrResponse(["PROVIDER", "SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  try {
    const want = new URL(req.url).searchParams.get("branch");
    const { branches, branch } = await scopeBranches(s, want);
    if (!branch) return NextResponse.json({ branch: null, branches: [], credentials: { configured: false }, webhook_url: "", return_url: "", endpoints: endpoints(), schemes: SIGNING_SCHEMES });

    const credentials = await getCheckoutCredsStatus(branch);
    const m = (await rows<{ webhook_url: string | null; return_url: string | null }>(
      "merchant",
      `SELECT COALESCE(webhook_url,'') AS webhook_url, COALESCE(return_url,'') AS return_url FROM merchants WHERE merchant_code = $1`,
      [branch],
    ).catch(() => []))[0] ?? { webhook_url: "", return_url: "" };

    return NextResponse.json({
      branch, branches, credentials,
      webhook_url: m.webhook_url ?? "", return_url: m.return_url ?? "",
      endpoints: endpoints(), schemes: SIGNING_SCHEMES,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const regenSchema = z.object({
  action: z.literal("regenerate"),
  branch: z.string().min(1),
  scheme: z.enum(["PAYU_SHA512", "HMAC_SHA256"]).default("HMAC_SHA256"),
});
const urlsSchema = z.object({
  action: z.literal("urls"),
  branch: z.string().min(1),
  webhook_url: z.string().url().or(z.literal("")).optional(),
  return_url: z.string().url().or(z.literal("")).optional(),
});
const bodySchema = z.discriminatedUnion("action", [regenSchema, urlsSchema]);

export async function POST(req: Request) {
  const g = await gateOrResponse(["PROVIDER", "SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;

  let body: z.infer<typeof bodySchema>;
  try { body = bodySchema.parse(await req.json()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }

  try {
    const codes = await resolveProviderMerchants(s);
    if (!codes.includes(body.branch))
      return NextResponse.json({ error: "branch out of scope" }, { status: 403 });

    if (body.action === "regenerate") {
      const creds = await issueCheckoutCreds(body.branch, body.scheme); // key + salt, ONCE
      return NextResponse.json({ creds }, { status: 201 });
    }

    // action === "urls" — set the branch's default return/webhook URLs.
    await rows(
      "merchant",
      `UPDATE merchants SET webhook_url = COALESCE($2, webhook_url), return_url = COALESCE($3, return_url) WHERE merchant_code = $1`,
      [body.branch, body.webhook_url ?? null, body.return_url ?? null],
    );
    return NextResponse.json({ ok: true });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
