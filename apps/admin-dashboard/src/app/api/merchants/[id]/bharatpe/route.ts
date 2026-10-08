// Guided BharatPe setup for one banker (lib/bharatpe-setup, lib/bharatpe-store,
// components/merchant/bharatpe-connect).
//
//   GET  /api/merchants/{id}/bharatpe   the BharatPe MIDs this banker has, and what the agent needs
//   POST /api/merchants/{id}/bharatpe   { label, bharatpe_merchant_id, payee_vpa, env,
//                                         replace_primary?, rotate_secret? }
//
// Saving a MID (1) writes the BharatPe UPI ID as the banker's P2P settlement VPA so Katana's pay page
// shows that QR and a captured credit is attributed to it, and (2) mints / keeps the per-MID API key
// and secret the Katana agent app signs its credit posts with. BharatPe has no API: nothing here
// calls or logs in to BharatPe. SUPER_ADMIN only; the secret is shown once on create / rotate and is
// never returned again.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { wormAppend } from "@/lib/worm";
import { validateBharatPeConfig, normaliseVpa } from "@/lib/bharatpe-setup";
import { listBharatPeMids, saveBharatPeMid } from "@/lib/bharatpe-store";

export const dynamic = "force-dynamic";

const publicBase = () => (process.env.PUBLIC_BASE_URL ?? "https://katanapay.co").replace(/\/$/, "");
const INGEST_URL = () => `${publicBase()}/api/v1/bharatpe/credit`;

async function bankerCode(id: string): Promise<string | null> {
  const m = await rows<{ merchant_code: string }>("merchant", `SELECT merchant_code FROM merchants WHERE id = $1::uuid`, [id]);
  return m[0]?.merchant_code ?? null;
}

async function readKatanaPay(code: string): Promise<Record<string, unknown>> {
  const r = await rows<{ katana_pay: unknown }>("merchant",
    `SELECT katana_pay FROM merchant_payment_config WHERE merchant_code = $1`, [code]);
  return (r[0]?.katana_pay as Record<string, unknown>) ?? {};
}

/** Add a VPA to the recognised (additional) list, and make it the payee when there is none yet. */
function withBharatPeVpa(cur: Record<string, unknown>, vpa: string, makePrimary: boolean): Record<string, unknown> {
  const next: Record<string, unknown> = { ...cur };
  const extra = new Set<string>(Array.isArray(cur.settlement_vpas) ? (cur.settlement_vpas as unknown[]).map((v) => normaliseVpa(v)).filter(Boolean) : []);
  extra.add(vpa);
  next.settlement_vpas = [...extra];
  if (makePrimary) {
    next.settlement_vpa = vpa;
    // A payee name is bound to its VPA elsewhere; a new payee drops a stale one.
    if (normaliseVpa(cur.settlement_vpa) !== vpa) { delete next.payee_name; delete (next as any).payee_name_vpa; }
  }
  return next;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  try {
    const code = await bankerCode((await params).id);
    if (!code) return NextResponse.json({ error: "banker not found" }, { status: 404 });
    const [mids, kp] = await Promise.all([listBharatPeMids(code), readKatanaPay(code)]);
    return NextResponse.json({
      banker: code,
      mids,
      settlement_vpa: normaliseVpa((kp as any).settlement_vpa) || null,
      ingest_url: INGEST_URL(),
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  label: z.string().trim().min(1).max(60),
  bharatpe_merchant_id: z.string().trim().max(24).optional(),
  payee_vpa: z.string().trim().max(120),
  env: z.enum(["PROD", "TEST"]),
  replace_primary: z.boolean().optional(),
  rotate_secret: z.boolean().optional(),
}).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const p = schema.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: p.error.issues[0].message }, { status: 400 });
  const b = p.data;
  const id = (await params).id;
  try {
    const code = await bankerCode(id);
    if (!code) return NextResponse.json({ error: "banker not found" }, { status: 404 });

    const valid = validateBharatPeConfig({ bharatpe_merchant_id: b.bharatpe_merchant_id, payee_vpa: b.payee_vpa, env: b.env });
    if (!valid.values) return NextResponse.json({ error: valid.error }, { status: 400 });
    const cfg = valid.values;

    // Make the BharatPe UPI ID the payee. A different payee already set is replaced only on confirm,
    // so turning on BharatPe never silently redirects a banker's existing collections.
    const kp = await readKatanaPay(code);
    const curPrimary = normaliseVpa((kp as any).settlement_vpa);
    const otherPrimary = !!curPrimary && curPrimary !== cfg.payee_vpa;
    if (otherPrimary && b.replace_primary !== true)
      return NextResponse.json({ error: "this banker already pays to another UPI ID; confirm to make the BharatPe UPI ID the one customers pay", code: "PRIMARY_TAKEN", current: curPrimary }, { status: 409 });

    const saved = await saveBharatPeMid({
      code, label: b.label, bharatpeMerchantId: cfg.bharatpe_merchant_id, payeeVpa: cfg.payee_vpa,
      env: cfg.env, rotateSecret: b.rotate_secret === true, by: g.session.email,
    });

    const nextKp = withBharatPeVpa(kp, cfg.payee_vpa, otherPrimary ? b.replace_primary === true : !curPrimary || curPrimary === cfg.payee_vpa);
    await rows("merchant", `
      INSERT INTO merchant_payment_config (merchant_code, katana_pay, updated_by, updated_at)
      VALUES ($1, $2::jsonb, $3, now())
      ON CONFLICT (merchant_code) DO UPDATE SET katana_pay = EXCLUDED.katana_pay, updated_by = EXCLUDED.updated_by, updated_at = now()
    `, [code, JSON.stringify(nextKp), g.session.email]);

    await wormAppend({
      actorId: g.session.user_id, actorEmail: g.session.email, action: "merchant.bharatpe.setup",
      resourceType: "merchant", resourceId: id,
      before: { settlement_vpa: curPrimary || null },
      after: { merchant_code: code, label: b.label, env: cfg.env, payee_vpa: cfg.payee_vpa, api_key_minted: !!saved.api_key, secret_rotated: !!saved.secret },
    }).catch(() => {});

    // The API key and secret are the ONLY time the secret is ever returned. The card shows it once.
    return NextResponse.json({
      mid: saved.row,
      api_key: saved.api_key ?? null,
      secret: saved.secret ?? null,
      ingest_url: INGEST_URL(),
    }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
