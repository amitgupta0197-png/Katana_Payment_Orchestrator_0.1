// /api/settlements — provider ↔ branch settlements.
//   GET  — scoped list (SUPER_ADMIN: all; PROVIDER: own; MERCHANT/branch: addressed
//          to it). Optional ?provider= &branch= &status= filters for admin/provider.
//   POST — a provider RAISES a settlement to a branch. SUPER_ADMIN + PROVIDER.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse } from "@/lib/scope";
import { branchKeysForMerchant } from "@/lib/provider-integration";
import { purposeForAmount, outstandingForBranch } from "@/lib/branch-settlement";
import { resolveRule, computeCharges, currentUsdtRate, computeUsdtQuantity } from "@/lib/settlement-rules";

export const dynamic = "force-dynamic";

// Enrich rows with provider code/name (provider DB) + branch name (merchant DB).
async function enrich(list: any[]): Promise<any[]> {
  if (!list.length) return list;
  const provIds = [...new Set(list.map((r) => r.provider_id))];
  const codes = [...new Set(list.map((r) => r.merchant_key))];
  const [provs, merchants] = await Promise.all([
    rows<any>("provider", `SELECT id::text, code, legal_name FROM providers WHERE id::text = ANY($1::text[])`, [provIds]).catch(() => []),
    rows<any>("merchant", `SELECT merchant_code, legal_name, COALESCE(brand_name,'') AS brand_name FROM merchants WHERE merchant_code = ANY($1::text[])`, [codes]).catch(() => []),
  ]);
  const pByx = new Map(provs.map((p: any) => [p.id, p]));
  const mByc = new Map(merchants.map((m: any) => [m.merchant_code, m]));
  return list.map((r) => ({
    ...r,
    provider_code: pByx.get(r.provider_id)?.code ?? null,
    provider_name: pByx.get(r.provider_id)?.legal_name ?? null,
    branch_name: mByc.get(r.merchant_key) ? (mByc.get(r.merchant_key).brand_name || mByc.get(r.merchant_key).legal_name) : null,
  }));
}

const SELECT = `
  SELECT id::text, provider_id::text, merchant_key, beneficiary_id::text, beneficiary_snapshot,
         amount::float AS amount, gross_amount::float AS gross_amount, net_amount::float AS net_amount,
         charges, rule_version, currency, purpose, status, utr, transfer_mode, note,
         COALESCE(settle_mode,'BANK') AS settle_mode, usdt_network, wallet_address,
         usdt_rate::float AS usdt_rate, usdt_quantity::float AS usdt_quantity, usdt_fee::float AS usdt_fee,
         tx_hash, request_ref, (receipt_uri IS NOT NULL) AS has_receipt,
         COALESCE(locked, false) AS locked, COALESCE(priority,'NORMAL') AS priority, requested_date, internal_ref,
         requested_by, requested_at, utr_submitted_by, utr_submitted_at,
         verified_by, verified_at, review_by, review_at, review_note, updated_at, created_at
    FROM provider_branch_settlements`;

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const url = new URL(req.url);
  const fProvider = url.searchParams.get("provider");
  const fBranch = url.searchParams.get("branch");
  const fStatus = url.searchParams.get("status");

  const where: string[] = []; const args: unknown[] = [];
  try {
    if (s.persona === "PROVIDER") { args.push(s.scope_id); where.push(`provider_id = $${args.length}::uuid`); }
    else if (s.persona === "MERCHANT") {
      const keys = await branchKeysForMerchant(s.scope_id!);
      args.push(keys); where.push(`merchant_key = ANY($${args.length}::text[])`);
    } else {
      if (fProvider) { args.push(fProvider); where.push(`provider_id = $${args.length}::uuid`); }
    }
    if (fBranch && s.persona !== "MERCHANT") { args.push(fBranch); where.push(`merchant_key = $${args.length}`); }
    if (fStatus) { args.push(fStatus); where.push(`status = $${args.length}`); }

    const list = await rows<any>("provider",
      `${SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 300`, args);
    return NextResponse.json({ settlements: await enrich(list) });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  provider_id: z.string().uuid().optional(), // required for SUPER_ADMIN; ignored for PROVIDER
  merchant_key: z.string().min(1).max(120),
  amount: z.coerce.number().positive().max(1_000_000_000),
  settle_mode: z.enum(["BANK", "USDT"]).default("BANK"),
  beneficiary_id: z.string().uuid().optional(),   // BANK: pay one of the provider's own accounts
  vendor_id: z.string().uuid().optional(),        // BANK: pay a registered vendor (BRD §3 model)
  usdt_network: z.enum(["TRC20", "ERC20", "BEP20"]).optional(),
  wallet_address: z.string().min(10).max(120).optional(),
  purpose: z.string().max(60).optional(),
  note: z.string().max(500).optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).default("NORMAL"),
  requested_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),  // preferred settlement date
  internal_ref: z.string().max(60).optional(),                          // upline's own reference
}).refine((b) => b.settle_mode === "USDT" || !!b.beneficiary_id || !!b.vendor_id, { message: "a vendor_id or beneficiary_id is required for a bank settlement" })
  .refine((b) => b.settle_mode === "BANK" || (!!b.usdt_network && !!b.wallet_address), { message: "usdt_network and wallet_address are required for a USDT settlement" });

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER"]);
  if ("response" in g) return g.response;
  const s = g.session;

  let body;
  try { body = createSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const providerId = s.persona === "PROVIDER" ? s.scope_id! : body.provider_id;
  if (!providerId) return NextResponse.json({ error: "provider_id required" }, { status: 400 });

  try {
    // BALANCE GUARD (BRD §11): the request must fit within the branch's available
    // balance — collected − settled − already-blocked in-flight requests — so the
    // same funds can never be settled twice. Admin may override.
    if (s.persona === "PROVIDER") {
      const bal = await outstandingForBranch(providerId, body.merchant_key);
      if (body.amount > bal.outstanding + 0.01)
        return NextResponse.json({
          error: `amount exceeds the branch's available balance (available ₹${bal.outstanding.toFixed(2)} = collected ₹${bal.collected.toFixed(2)} − settled ₹${bal.settled.toFixed(2)} − in-flight ₹${bal.blocked.toFixed(2)})`,
        }, { status: 409 });
    }

    // BANK: the pay-to target is either a registered VENDOR (BRD §3 — the downline pays
    // the upline's vendor directly) or one of the provider's own beneficiary accounts.
    // Both are snapshotted so the branch always sees the exact account it was told to
    // pay, even if the record is later edited/blocked.
    let ben: any = null;
    let vendorId: string | null = null;
    if (body.settle_mode === "BANK") {
      if (body.vendor_id) {
        const v = (await rows<any>("provider", `
          SELECT id::text, vendor_name, beneficiary_name, account_number, ifsc, bank_name, vpa, mobile_number, status
            FROM provider_vendors WHERE id = $1::uuid AND provider_id = $2::uuid
        `, [body.vendor_id, providerId]))[0];
        if (!v) return NextResponse.json({ error: "vendor not found for this provider" }, { status: 404 });
        if (v.status !== "ACTIVE")
          return NextResponse.json({ error: `vendor is ${v.status} — only ACTIVE vendors can receive settlements` }, { status: 409 });
        vendorId = v.id;
        ben = { id: null, label: v.vendor_name, beneficiary_name: v.beneficiary_name, account_number: v.account_number,
                ifsc: v.ifsc, bank_name: v.bank_name, mobile_number: v.mobile_number, vpa: v.vpa,
                transfer_mode: v.vpa ? "UPI" : "IMPS", vendor_id: v.id, vendor_name: v.vendor_name };
      } else {
        ben = (await rows<any>("provider", `
          SELECT id::text, label, beneficiary_name, account_number, ifsc, bank_name, mobile_number, vpa, transfer_mode
            FROM provider_beneficiary_accounts WHERE id = $1::uuid AND provider_id = $2::uuid AND active = true
        `, [body.beneficiary_id, providerId]))[0];
        if (!ben) return NextResponse.json({ error: "beneficiary not found / not active for this provider" }, { status: 404 });
      }
    }

    const purpose = body.purpose || purposeForAmount(body.amount);

    // Rule engine: resolve the applicable commission rule and snapshot the full
    // gross → charges → net breakdown on the settlement, so pricing changes made
    // later never rewrite this request (BRD §6). `amount` stays = gross (back-compat
    // with the outstanding calc); `net_amount` is what the downline pays out.
    const rule = await resolveRule(providerId, body.merchant_key);
    const breakdown = computeCharges(body.amount, rule);

    // USDT: lock today's declared rate at request creation and compute the quantity
    // (net INR ÷ rate − network fee, BRD §8). No declared rate → cannot raise.
    let usdt: { rate: number; qty: number; fee: number } | null = null;
    if (body.settle_mode === "USDT") {
      const rate = await currentUsdtRate(body.usdt_network!);
      if (!rate) return NextResponse.json({ error: `no active USDT rate declared for ${body.usdt_network} — ask Katana admin to set today's rate` }, { status: 409 });
      const q = computeUsdtQuantity(breakdown.net, rate);
      usdt = { rate: rate.settlement_rate, qty: q.final_qty, fee: q.fee };
    }

    const ins = await rows<any>("provider", `
      INSERT INTO provider_branch_settlements
        (provider_id, merchant_key, beneficiary_id, vendor_id, beneficiary_snapshot, amount, purpose, transfer_mode, note, status, requested_by,
         gross_amount, net_amount, charges, rule_id, rule_version,
         settle_mode, usdt_network, wallet_address, usdt_rate, usdt_quantity, usdt_fee,
         priority, requested_date, internal_ref, request_ref)
      VALUES ($1::uuid,$2,$3::uuid,$21::uuid,$4::jsonb,$5,$6,$7,$8,'REQUESTED',$9,$10,$11,$12::jsonb,$13::uuid,$14,
              $15,$16,$17,$18,$19,$20,$22,$23::date,$24,
              'KTN-SET-' || lpad(nextval('settlement_ref_seq')::text, 6, '0'))
      RETURNING id::text, provider_id::text, merchant_key, amount::float AS amount,
                gross_amount::float AS gross_amount, net_amount::float AS net_amount, charges,
                settle_mode, usdt_network, usdt_rate::float AS usdt_rate, usdt_quantity::float AS usdt_quantity,
                request_ref, currency, status, purpose, created_at
    `, [providerId, body.merchant_key, ben?.id ?? null, ben ? JSON.stringify(ben) : null, body.amount, purpose,
        body.settle_mode === "USDT" ? "USDT" : ben?.transfer_mode ?? null, body.note ?? null, s.email,
        breakdown.gross, breakdown.net, JSON.stringify(breakdown), breakdown.rule_id, breakdown.rule_version,
        body.settle_mode, body.usdt_network ?? null, body.wallet_address ?? null,
        usdt?.rate ?? null, usdt?.qty ?? null, usdt?.fee ?? null, vendorId,
        body.priority, body.requested_date ?? null, body.internal_ref ?? null]);

    // The raise is the FIRST entry of the immutable timeline ("submitted by Upline" —
    // BRD §4 example starts here, not at acceptance).
    await rows("provider", `
      INSERT INTO provider_settlement_events (settlement_id, provider_id, action, from_status, to_status, actor, actor_role, remarks, details)
      VALUES ($1::uuid, $2::uuid, 'SUBMIT', NULL, 'REQUESTED', $3, $4, $5, $6::jsonb)
    `, [ins[0].id, providerId, s.email, s.persona === "PROVIDER" ? "UPLINE" : "ADMIN", body.note ?? null,
        JSON.stringify({ gross: breakdown.gross, net: breakdown.net, mode: body.settle_mode, usdt: usdt ?? undefined })]).catch(() => {});

    await rows("provider", `
      INSERT INTO provider_audit_logs (provider_id, actor, action, payload)
      VALUES ($1::uuid, $2, 'provider.settlement.raised', $3::jsonb)
    `, [providerId, s.email, JSON.stringify({ ref: ins[0].request_ref, branch: body.merchant_key, amount: body.amount, mode: body.settle_mode, purpose, net: breakdown.net, charges: breakdown.total_charges, rule_version: breakdown.rule_version, usdt: usdt ?? undefined })]).catch(() => {});

    return NextResponse.json({ settlement: ins[0] });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
