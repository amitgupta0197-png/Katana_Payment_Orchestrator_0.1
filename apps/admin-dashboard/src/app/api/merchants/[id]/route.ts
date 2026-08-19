// Persona policy (PRODUCT_VISION §3.3):
//   SUPER_ADMIN — U ✓ all fields.
//   PROVIDER    — U KYC + bank only (subset).
//   MERCHANT    — U contact + webhook URL only (subset).

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { publish } from "@/lib/events";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  contact_email: z.string().email().optional(),
  contact_phone: z.string().optional(),
  webhook_url: z.string().url().optional().or(z.literal("")),
  return_url: z.string().url().optional().or(z.literal("")),
  stage: z.string().optional(),
  risk_tier: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  let body;
  try { body = updateSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  // Persona-restricted field allowlists.
  const allowed = s.persona === "SUPER_ADMIN"
    ? new Set(Object.keys(updateSchema.shape))
    : s.persona === "PROVIDER"
      ? new Set(["risk_tier"]) // KYC + bank are tracked in their own tables; expose later.
      : new Set(["contact_email", "contact_phone", "webhook_url", "return_url"]);
  const fields = Object.fromEntries(
    Object.entries(body).filter(([k, v]) => allowed.has(k) && v !== undefined),
  );
  if (Object.keys(fields).length === 0)
    return NextResponse.json({ error: "no fields you may edit were supplied" }, { status: 400 });

  // Scope check.
  if (s.persona === "MERCHANT" && s.scope_id !== id)
    return NextResponse.json({ error: "merchants can only edit own row" }, { status: 403 });
  if (s.persona === "PROVIDER") {
    const codes = await resolveProviderMerchants(s); // returns merchant_codes
    const m = await rows<{ merchant_code: string }>("merchant", `SELECT merchant_code FROM merchants WHERE id = $1::uuid`, [id]);
    if (!m.length || !codes.includes(m[0].merchant_code))
      return NextResponse.json({ error: "merchant not mapped to your merchant" }, { status: 403 });
  }

  try {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      args.push(v);
      sets.push(`${k} = $${args.length}`);
    }
    args.push(id);
    const res = await rows<any>("merchant", `
      UPDATE merchants SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $${args.length}::uuid
       RETURNING id, merchant_code, contact_email, contact_phone, stage, risk_tier
    `, args);
    if (!res.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    await rows("merchant", `
      INSERT INTO merchant_activity (merchant_id, action, actor, payload)
      VALUES ($1::uuid, 'PROFILE_UPDATED', $2, $3::jsonb)
    `, [id, s.email, JSON.stringify(fields)]).catch(() => {});
    return NextResponse.json(res[0]);
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

/**
 * DELETE a banker outright.
 *
 * Housekeeping, not a lifecycle step. This is for rows that should never have existed — an
 * onboarding test, a duplicate, a typo'd code — and it is deliberately not a substitute for
 * SUSPENDED/TERMINATED, which are reversible and keep the banker's history intact.
 *
 * So it refuses anything that has handled money or is in use:
 *
 *   • captured credits        — vendor_txn_alerts rows are the record of money that arrived on
 *                               this banker's UPI IDs. Deleting the banker would strand them
 *                               under a code that resolves to nothing.
 *   • pay-in orders           — same argument for orders raised against it.
 *   • settlement history      — provider_branch_settlements is money paid out to it.
 *   • a live capture device   — a phone that heartbeated in the last week is actively collecting
 *                               for this banker. It has no credits YET, which is exactly why the
 *                               money checks above cannot see it.
 *
 * NOT guarded on stage, deliberately. `LIVE` looks like the meaningful signal and is not: 11 of
 * the 12 bankers on prod sit at LIVE, including empty ones that have never taken a payment, so
 * refusing on it would block the housekeeping this endpoint exists for while protecting nothing
 * the checks above don't already cover.
 *
 * The banker's rows live in FIVE databases and none of them have a foreign key to `merchants`
 * (the child tables carry a bare merchant_id/merchant_code), so nothing cascades and every table
 * is cleared explicitly. What goes with the banker:
 *
 *   provider  — its mapping(s) to any merchant
 *   merchant  — activity, bank accounts, KYB documents, risk profile, payment + Pine Labs config
 *   vendor    — its device enrolments (an enrolment naming a banker that no longer exists would
 *               let a phone keep posting credits under a dead code)
 *   iam/auth  — its login, by the same rule the provider delete follows: a credential scoped to
 *               something deleted is a way in and nothing else
 *
 * Counted rather than silent: the caller is told what went, because "deleted" alone gives an
 * operator no way to notice that a banker took four device enrolments with it.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gateOrResponse(["SUPER_ADMIN"]);
  if ("response" in g) return g.response;
  const s = g.session;
  const { id } = await params;

  try {
    const before = await rows<{ merchant_code: string; legal_name: string; stage: string }>(
      "merchant",
      `SELECT merchant_code, legal_name, stage FROM merchants WHERE id = $1::uuid`, [id],
    );
    if (!before.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    const b = before[0];
    const code = b.merchant_code;

    const count = async (dbKey: Parameters<typeof rows>[0], sql: string) =>
      Number((await rows<{ n: string }>(dbKey, sql, [code]).catch(() => [{ n: "0" }]))[0]?.n ?? 0);

    const credits = await count("vendorGateway",
      `SELECT COUNT(*)::text AS n FROM vendor_txn_alerts WHERE merchant_id = $1`);
    if (credits > 0)
      return NextResponse.json({
        error: `${code} has ${credits} captured credit(s) — deleting would strand money records; suspend it instead`,
        code, reason: "HAS_CREDITS",
      }, { status: 409 });

    const payins = await count("vendorGateway",
      `SELECT COUNT(*)::text AS n FROM vendor_payin_orders WHERE merchant_id = $1`);
    if (payins > 0)
      return NextResponse.json({
        error: `${code} has ${payins} pay-in order(s) — deleting would strand them; suspend it instead`,
        code, reason: "HAS_PAYINS",
      }, { status: 409 });

    const settlements = await count("provider",
      `SELECT COUNT(*)::text AS n FROM provider_branch_settlements WHERE merchant_key = $1`);
    if (settlements > 0)
      return NextResponse.json({
        error: `${code} has ${settlements} settlement record(s) — deleting would destroy money history; suspend it instead`,
        code, reason: "HAS_SETTLEMENTS",
      }, { status: 409 });

    // A capture phone that is still checking in belongs to a banker in service, whether or not any
    // money has landed yet. Stale enrolments do not block — those are cleared with the banker.
    const live = await rows<{ device_id: string }>("vendorGateway", `
      SELECT device_id FROM vendor_devices
       WHERE merchant_id = $1 AND last_heartbeat > now() - interval '7 days' LIMIT 3
    `, [code]).catch(() => []);
    if (live.length)
      return NextResponse.json({
        error: `${code} has a capture device still reporting (${live.map((d) => d.device_id).join(", ")}) — it is in use; suspend it instead`,
        code, reason: "LIVE_DEVICE",
      }, { status: 409 });

    // Mappings key on the merchant UUID on newer rows and the merchant_code on very old ones —
    // clear both forms or a legacy banker keeps showing under its merchant after deletion.
    const unmapped = await rows<{ id: string }>("provider", `
      DELETE FROM provider_merchant_mappings
       WHERE merchant_id::text = $1 OR merchant_id::text = $2
       RETURNING id::text
    `, [id, code]).catch(() => []);

    const devices = await rows<{ device_id: string }>("vendorGateway", `
      DELETE FROM vendor_devices WHERE merchant_id = $1 RETURNING device_id
    `, [code]).catch(() => []);

    for (const sql of [
      `DELETE FROM merchant_activity WHERE merchant_id = $1::uuid`,
      `DELETE FROM merchant_bank_accounts WHERE merchant_id = $1::uuid`,
      `DELETE FROM merchant_kyb_documents WHERE merchant_id = $1::uuid`,
      `DELETE FROM merchant_risk_profiles WHERE merchant_id = $1::uuid`,
    ]) await rows("merchant", sql, [id]).catch(() => {});
    for (const sql of [
      `DELETE FROM merchant_payment_config WHERE merchant_code = $1`,
      `DELETE FROM pinelabs_config WHERE merchant_code = $1`,
    ]) await rows("merchant", sql, [code]).catch(() => {});

    const gone = await rows<{ id: string }>("merchant",
      `DELETE FROM merchants WHERE id = $1::uuid RETURNING id::text`, [id]);
    if (!gone.length) return NextResponse.json({ error: "not found" }, { status: 404 });

    // THE LOGIN GOES WITH IT — same reasoning as the provider delete. A banker's credential is an
    // auth.users row plus an iam.user_personas grant whose scope_id is the merchant_code; leaving
    // the grant behind would keep a working login pointed at a scope that no longer resolves.
    // Best-effort: the banker row is already gone and must not be resurrected by another service
    // failing, so the counts are reported instead of thrown.
    let personasRevoked = 0;
    let loginsDisabled = 0;
    try {
      const revoked = await rows<{ user_id: string }>("iam", `
        DELETE FROM user_personas
         WHERE persona_kind = 'MERCHANT' AND scope_id = $1
         RETURNING user_id::text
      `, [code]);
      personasRevoked = revoked.length;
      for (const { user_id } of revoked) {
        const left = await rows<{ n: string }>("iam",
          `SELECT COUNT(*)::text AS n FROM user_personas WHERE user_id = $1::uuid`, [user_id]).catch(() => [{ n: "1" }]);
        if (Number(left[0]?.n ?? 1) > 0) continue;         // still has another role — leave it alone
        const off = await rows<{ id: string }>("auth", `
          UPDATE users SET status = 'disabled', updated_at = now()
           WHERE id = $1::uuid AND status <> 'disabled' RETURNING id::text
        `, [user_id]).catch(() => []);
        loginsDisabled += off.length;
      }
    } catch { /* reported as 0 below; the banker is already deleted */ }

    // merchant_activity went with the banker, so the trail is the event stream.
    await publish({
      eventType: "merchant.deleted",
      producer: "merchant_mgmt",
      entityType: "merchant", entityId: id, actorId: s.user_id,
      payload: {
        merchant_code: code, legal_name: b.legal_name, stage: b.stage,
        mappings_removed: unmapped.length, devices_removed: devices.length,
        personas_revoked: personasRevoked, logins_disabled: loginsDisabled,
        deleted_by: s.email,
      },
    });

    return NextResponse.json({
      deleted: id, code, legal_name: b.legal_name,
      mappings_removed: unmapped.length,
      devices_removed: devices.length,
      personas_revoked: personasRevoked,
      logins_disabled: loginsDisabled,
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
