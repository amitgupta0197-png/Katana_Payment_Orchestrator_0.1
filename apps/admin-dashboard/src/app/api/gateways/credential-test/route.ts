// POST /api/gateways/credential-test — try a payment account's credentials before they are saved
// (banker wizard "Test connection"; lib/credential-test). Super Admin. Nothing is stored and no
// credential is returned or logged.
//   { gateway: PAYU | CASHFREE | … , env, auth?, fields }            a status lookup for a made-up order
//   { gateway: "PAYATOM", env, payatom: { pid, secret, api_key, api_base, latitude, longitude } }
//     one signed request (₹201, never paid) — PayAtom has no other call that checks the signature.

import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { gatewayDef, validateCredFields } from "@/lib/pg-catalog";
import type { GatewayMid } from "@/lib/gateway-creds";
import { payinConnectorFor } from "@/lib/payin-providers";
import { payatomSign } from "@/lib/payin-providers/payatom";
import { verifyPayuTxn } from "@/lib/payu-verify";
import { readPayatomAnswer, readPayuVerify, readStatusAnswer, type CredVerdict } from "@/lib/credential-test";

export const dynamic = "force-dynamic";

const schema = z.object({
  gateway: z.string().max(20),
  env: z.enum(["TEST", "PROD"]),
  auth: z.string().max(40).nullable().optional(),
  fields: z.record(z.string().max(500)).optional(),
  payatom: z.object({
    pid: z.string().max(200), secret: z.string().max(500), api_key: z.string().max(500),
    api_base: z.string().max(300), latitude: z.string().max(20), longitude: z.string().max(20),
  }).optional(),
});
const CORE = new Set(["mid_code", "key", "salt"]);

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
  const ref = "KTNCHK" + Date.now();

  if (body.gateway === "PAYATOM") {
    const p = body.payatom;
    if (!p || !/^https:\/\//i.test(p.api_base.trim())) return NextResponse.json({ error: "PayAtom needs PID, secret, API key and an https API base" }, { status: 400 });
    const params: Record<string, unknown> = {
      pid: p.pid.trim(), amount: 201, order_id: ref, ip: "72.61.227.233", name: "Katana Check", email: "check@katanapay.co",
      phone: "9999999999", latitude: p.latitude.trim(), longitude: p.longitude.trim(), customer_id: "9999999999",
    };
    params.signature = payatomSign(params, p.secret.trim());
    let verdict: CredVerdict;
    try {
      const r = await fetch(`${p.api_base.trim().replace(/\/$/, "")}/api/v2/request.php`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "X-Api-Key": p.api_key.trim() },
        body: JSON.stringify(params), signal: AbortSignal.timeout(20_000),
      });
      const j = await r.json().catch(() => null);
      verdict = readPayatomAnswer(r.status, j);
    } catch { verdict = { result: "UNKNOWN", message: "Couldn't reach PayAtom at that API base URL." }; }
    return NextResponse.json(verdict);
  }

  const def = gatewayDef(body.gateway);
  if (!def) return NextResponse.json({ error: "unknown gateway" }, { status: 400 });
  const alt = body.auth && body.auth !== "key_salt" ? def.payin.altAuth?.find((m) => m.id === body.auth) : undefined;
  const v = validateCredFields(def.payin, body.fields ?? {}, alt?.id);
  if (!v.values) return NextResponse.json({ result: "WRONG", message: v.error ?? "check the fields" } satisfies CredVerdict);
  const f = v.values;
  const extra = Object.fromEntries(Object.entries(f).filter(([k]) => !CORE.has(k)));
  const mid: GatewayMid = {
    gateway: def.id, mid_code: f.mid_code ?? f.key ?? "", key: f.key ?? "", salt: f.salt ?? "",
    scheme: def.id === "PAYU" ? "PAYU_SHA512" : "HMAC_SHA256", env: body.env,
    ...(alt ? { auth: alt.id } : {}), ...(Object.keys(extra).length ? { extra } : {}),
  };
  try {
    if (def.id === "PAYU" && !alt) return NextResponse.json(readPayuVerify((await verifyPayuTxn(mid, ref)).status));
    const c = payinConnectorFor(mid);
    if (!c) return NextResponse.json({ result: "UNKNOWN", message: `${def.name} can't be checked before saving.` } satisfies CredVerdict);
    const a = await c.status(mid, ref, 100n);
    return NextResponse.json(readStatusAnswer(def.name, a.ok ? { ok: true } : { ok: false, error: a.error }));
  } catch (e) {
    return NextResponse.json({ result: "UNKNOWN", message: `Couldn't check ${def.name}: ${(e as Error).message}` } satisfies CredVerdict);
  }
}
