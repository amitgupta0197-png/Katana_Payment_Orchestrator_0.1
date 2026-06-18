// Persona policy (BRD §7 P3 + PRODUCT_VISION §3.5):
//   SUPER_ADMIN — R all, C ✓ (on behalf of merchant).
//   PROVIDER    — R mapped merchants only.
//   MERCHANT    — C ✓ own, R own only.
//
// POST runs the full Sprint-2 lifecycle:
//   1. Idempotency check (idempotency_key)
//   2. amount → amount_minor via lib/money.ts
//   3. lib/routing.pickRoute() to produce ranked candidates (BRD §6 scoring)
//   4. lib/payment-adapters.getAdapter().charge() on the top candidate
//      (cascading to next rank on transient failure)
//   5. Persist order, attempt, transition, routing_decision
//   6. Publish payment.created, route.selected, payment.succeeded/failed events

import { NextResponse } from "next/server";
import { z } from "zod";
import { rows, pgError } from "@/lib/pg";
import { gateOrResponse, resolveProviderMerchants } from "@/lib/scope";
import { toMinor, fromMinor } from "@/lib/money";
import { pickRoute, persistDecision, type RouteCandidate } from "@/lib/routing";
import { getAdapter } from "@/lib/payment-adapters";
import type { PaymentState } from "@/lib/payment-states";
import { publish } from "@/lib/events";
import { enqueue as enqueueWebhook } from "@/lib/webhook-outbox";
import { recordFailure as recordCircuitFailure, recordSuccess as recordCircuitSuccess } from "@/lib/circuit-breaker";
import { computeRiskScore, recordRiskScore } from "@/lib/risk";
import { decideSca } from "@/lib/sca";
import { postJournal } from "@/lib/ledger";
import { getGatewayMid, signForGateway } from "@/lib/gateway-creds";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "PROVIDER", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);

  try {
    const params: unknown[] = ["tenant-default"];
    let where = "tenant_id = $1";
    if (s.persona === "MERCHANT") {
      where += ` AND merchant_id = $${params.length + 1}`;
      params.push(s.scope_id);
    } else if (s.persona === "PROVIDER") {
      const ids = await resolveProviderMerchants(s);
      if (!ids.length) return NextResponse.json({ orders: [] });
      where += ` AND merchant_id = ANY($${params.length + 1}::text[])`;
      params.push(ids);
    }
    if (status) { where += ` AND status = $${params.length + 1}`; params.push(status); }

    const orders = await rows<any>("checkout", `
      SELECT id, tenant_id, merchant_id, client_ref, txn_id, amount, amount_minor::text,
             currency, method, selected_rail, status, created_at
        FROM checkout_orders
       WHERE ${where}
       ORDER BY created_at DESC LIMIT ${limit}
    `, params);
    return NextResponse.json({ orders });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const createSchema = z.object({
  client_ref: z.string().min(1).max(120),
  amount: z.union([z.number().positive(), z.string()]),
  currency: z.string().default("INR"),
  method: z.enum(["UPI_INTENT","UPI_COLLECT","CARD","NETBANKING","WALLET","QR","CRYPTO"]),
  customer_email: z.string().email().optional(),
  idempotency_key: z.string().min(1).max(120).optional(),
  risk_score: z.number().min(0).max(1).optional(),
});

const RAIL_METHOD: Record<string, string> = {
  UPI_INTENT: "UPI_INTENT", UPI_COLLECT: "UPI_COLLECT", CARD: "CARD",
  NETBANKING: "NETBANKING", NET_BANKING: "NETBANKING",
  WALLET: "WALLET", QR: "QR", CRYPTO: "CRYPTO",
};
function isRetryable(errorCode?: string): boolean {
  if (!errorCode) return false;
  return ["TIMEOUT", "PROVIDER_DOWN", "RATE_LIMITED"].includes(errorCode);
}

export async function POST(req: Request) {
  const g = await gateOrResponse(["SUPER_ADMIN", "MERCHANT"]);
  if ("response" in g) return g.response;
  const s = g.session;
  if (s.persona === "MERCHANT" && !s.scope_id)
    return NextResponse.json({ error: "merchant session missing scope" }, { status: 403 });

  let body;
  try { body = createSchema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const merchantId = s.persona === "MERCHANT" ? s.scope_id! : "tenant-default";
  const amountMinor = toMinor(typeof body.amount === "number" ? body.amount.toString() : body.amount, body.currency);

  try {
    // Idempotency: replay the existing order if the key was already used.
    if (body.idempotency_key) {
      const existing = await rows<any>("checkout",
        "SELECT id, txn_id, status, selected_rail, amount, currency FROM checkout_orders WHERE idempotency_key = $1 LIMIT 1",
        [body.idempotency_key]);
      if (existing.length) {
        return NextResponse.json({ order: existing[0], idempotent_replay: true }, { status: 200 });
      }
    }

    const txnId = "TXN-" + randomBytes(8).toString("hex").toUpperCase();
    const railMethod = RAIL_METHOD[body.method] ?? body.method;

    // 1. Create order in CREATED state.
    const orderRow = (await rows<any>("checkout", `
      INSERT INTO checkout_orders
        (tenant_id, merchant_id, client_ref, txn_id, amount, amount_minor, currency,
         method, status, idempotency_key, customer_email)
      VALUES ('tenant-default', $1, $2, $3, $4, $5, $6, $7, 'CREATED', $8, $9)
      RETURNING id, client_ref, txn_id, amount, amount_minor::text, currency, method, status, created_at
    `, [
      merchantId, body.client_ref, txnId,
      Number(fromMinor(amountMinor, body.currency)),
      String(amountMinor), body.currency, body.method,
      body.idempotency_key ?? null, body.customer_email ?? null,
    ]))[0];

    await rows("checkout", `
      INSERT INTO order_state_transitions
        (order_id, from_status, to_status, actor_kind, actor_id, reason)
      VALUES ($1::uuid, NULL, 'CREATED', 'system', $2, 'order created')
    `, [orderRow.id, s.user_id]).catch(() => {});

    await publish({
      eventType: "payment.created", producer: "payment_core",
      entityType: "payment", entityId: orderRow.id, actorId: s.user_id,
      payload: { txn_id: txnId, merchant_id: merchantId, amount_minor: String(amountMinor), currency: body.currency, method: body.method },
    });

    // 1.5 Gateway MID mapping. The merchant authenticated with their Katana key;
    //     Katana now resolves *its own* stored gateway Key+Salt for this merchant
    //     (sealed in the vault, never exposed) and signs the outbound gateway
    //     request itself. signature is a one-way hash — safe to surface/audit.
    let gatewaySigned: { gateway: string; mid_code: string; scheme: string; signature: string } | null = null;
    const gwMid = await getGatewayMid(merchantId).catch(() => null);
    if (gwMid) {
      const signed = signForGateway(gwMid, {
        txnId, amount: String(fromMinor(amountMinor, body.currency)),
        productinfo: body.client_ref ?? undefined, email: body.customer_email ?? undefined,
      });
      gatewaySigned = { gateway: gwMid.gateway, mid_code: gwMid.mid_code, scheme: signed.scheme, signature: signed.signature };
    }

    // 1a. Risk score (BRD §9). BLOCK terminates the lifecycle here.
    const risk = await computeRiskScore({
      merchantId, amountMinor, currency: body.currency,
      customerRef: body.customer_email, method: body.method,
    });
    await recordRiskScore({
      orderId: orderRow.id, merchantId,
      total: risk.total, decision: risk.decision, components: risk.components,
    });
    if (risk.decision === "BLOCK") {
      await rows("checkout",
        "UPDATE checkout_orders SET status='FAILED' WHERE id=$1::uuid", [orderRow.id]);
      await rows("checkout", `
        INSERT INTO order_state_transitions (order_id, from_status, to_status, actor_kind, reason, payload)
        VALUES ($1::uuid, 'CREATED', 'FAILED', 'system', 'risk_score BLOCK', $2::jsonb)
      `, [orderRow.id, JSON.stringify({ risk })]).catch(() => {});
      await publish({
        eventType: "risk.alert", producer: "risk_engine",
        entityType: "payment", entityId: orderRow.id, actorId: s.user_id,
        payload: { kind: "block", risk_score: risk.total, components: risk.components },
      });
      return NextResponse.json({ order: { ...orderRow, status: "FAILED" }, risk, error: "blocked by risk engine" }, { status: 403 });
    }

    // 1b. SCA decision (BRD §7 P3) — card-only; informs the adapter and is
    //     persisted on the attempt's exemption_reason / next_state.
    const sca = await decideSca({
      merchantId, method: body.method, amountMinor, currency: body.currency,
      riskScore: risk.total,
    });

    // 2. Routing — pick candidates (kill-switch and OPEN circuit providers excluded).
    const { candidates, weights_applied, excluded, experiment } = await pickRoute({
      method: railMethod, amountMinor, currency: body.currency,
      merchantId, riskScore: risk.total, txnId,
    });
    if (candidates.length === 0) {
      await rows("checkout",
        "UPDATE checkout_orders SET status='FAILED' WHERE id=$1::uuid", [orderRow.id]);
      await rows("checkout", `
        INSERT INTO order_state_transitions (order_id, from_status, to_status, actor_kind, reason)
        VALUES ($1::uuid, 'CREATED', 'FAILED', 'system', $2)
      `, [orderRow.id, excluded.length ? `all providers excluded: ${excluded.map(e=>`${e.provider}=${e.reason}`).join(", ")}` : "no providers available for method"]).catch(() => {});
      return NextResponse.json({ order: { ...orderRow, status: "FAILED" }, excluded, error: excluded.length ? "all providers excluded" : "no providers configured for method" }, { status: 503 });
    }

    // 3. Cascade through candidates until one resolves to a terminal-or-pending state.
    let selectedRank = 1;
    let chosen: RouteCandidate = candidates[0];
    let chargeResult = null as Awaited<ReturnType<ReturnType<typeof getAdapter>["charge"]>> | null;
    let attemptNo = 0;
    for (const cand of candidates) {
      attemptNo += 1;
      const adapter = getAdapter(cand.provider);
      chargeResult = await adapter.charge({
        orderId: orderRow.id, txnId, amountMinor, currency: body.currency,
        method: body.method, customerEmail: body.customer_email, attemptNo,
      });

      // SCA decision takes precedence over the adapter's authStatus for the
      // recorded auth_status / exemption_reason (BRD §7 acceptance).
      const recordedAuthStatus =
        sca.flow === "CHALLENGE" ? "CHALLENGE_REQUIRED" :
        sca.flow === "EXEMPTED"  ? "EXEMPTED" :
        chargeResult.authStatus ?? "NOT_REQUIRED";
      const recordedExemption =
        sca.exemption_reason ?? chargeResult.exemptionReason ?? null;

      await rows("checkout", `
        INSERT INTO checkout_attempts
          (order_id, attempt_no, rail_provider, rail_method, status, rail_ref,
           next_state, auth_status, exemption_reason, error_code, error_message,
           response_time_ms, raw_response, started_at, completed_at)
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, now(), now())
      `, [
        orderRow.id, attemptNo, cand.provider, body.method,
        chargeResult.outcome, chargeResult.providerTxnId ?? null,
        chargeResult.nextState, recordedAuthStatus,
        recordedExemption, chargeResult.errorCode ?? null,
        chargeResult.errorMessage ?? null, chargeResult.responseTimeMs,
        JSON.stringify({ ...chargeResult.raw, sca, gateway: gatewaySigned }),
      ]).catch(() => {});

      // Record the outcome on the provider's circuit breaker. SUCCESS /
      // AUTH_REQUIRED / PROCESSING are all "the provider answered" — they
      // close (or reset) the breaker. FAILED bumps consecutive_failures and
      // can trip CLOSED → OPEN.
      if (chargeResult.outcome === "FAILED") {
        await recordCircuitFailure(cand.provider).catch(() => null);
      } else {
        await recordCircuitSuccess(cand.provider).catch(() => null);
      }

      if (chargeResult.outcome !== "FAILED" || !isRetryable(chargeResult.errorCode)) {
        chosen = cand;
        selectedRank = cand.rank;
        break;
      }
    }
    if (!chargeResult) {
      return NextResponse.json({ error: "no charge attempt completed" }, { status: 500 });
    }

    // 4. Persist routing decision (replayable trace).
    await persistDecision({
      orderId: orderRow.id, merchantId, method: railMethod,
      amountMinor, currency: body.currency,
      candidates, weightsApplied: weights_applied,
      selectedRank, txnId,
      experimentId: experiment?.id ?? null,
      experimentBucket: experiment?.bucket ?? null,
    });

    await publish({
      eventType: "route.selected", producer: "routing_engine",
      entityType: "payment", entityId: orderRow.id, actorId: s.user_id,
      payload: { txn_id: txnId, provider: chosen.provider, score: chosen.score,
                 selected_rank: selectedRank, candidates: candidates.map(c => ({ provider: c.provider, score: c.score, rank: c.rank })) },
    });

    // 5. Move order to the next state returned by the adapter.
    const nextStatus = chargeResult.nextState as PaymentState;
    await rows("checkout", `
      UPDATE checkout_orders
         SET status=$1, selected_rail=$2
       WHERE id=$3::uuid
    `, [nextStatus, chosen.provider, orderRow.id]);
    await rows("checkout", `
      INSERT INTO order_state_transitions
        (order_id, from_status, to_status, actor_kind, reason, payload)
      VALUES ($1::uuid, 'CREATED', $2, 'system', $3, $4::jsonb)
    `, [orderRow.id, nextStatus, `adapter ${chosen.provider} returned ${chargeResult.outcome}`,
        JSON.stringify({ providerTxnId: chargeResult.providerTxnId, authStatus: chargeResult.authStatus })]).catch(() => {});

    let postedJournalId: string | null = null;
    let ledgerBreakdown: { gross: string; commission: string; reserve: string; net: string } | null = null;

    if (nextStatus === "SUCCESS") {
      // Double-entry posting (BRD §10 P6). MDR comes from the winning rail.
      const railMdrBps = (await rows<{ mdr_bps: number }>("routingEngine",
        `SELECT mdr_bps FROM rails WHERE provider=$1 AND method=$2 AND direction='PAYIN' LIMIT 1`,
        [chosen.provider, railMethod]).catch(() => []))[0]?.mdr_bps ?? 195;
      const RESERVE_BPS = 500;  // 5% default; Sprint 6 reserve_rules deepens this per risk tier.

      const commissionMinor = (amountMinor * BigInt(railMdrBps)) / 10000n;
      const reserveMinor    = (amountMinor * BigInt(RESERVE_BPS)) / 10000n;
      const merchantNetMinor = amountMinor - commissionMinor - reserveMinor;

      try {
        const j = await postJournal({
          journal_type: "payment.success",
          narration: `Payment success ${txnId} via ${chosen.provider}`,
          currency: body.currency,
          merchant_id: merchantId,
          ref: { type: "payment", id: txnId },
          idempotency_key: `payment.success:${txnId}`,
          lines: [
            { account_code: `ASSETS.PG_FLOAT.${chosen.provider}`, account_type: "ASSET",
              side: "D", amount_minor: amountMinor, currency: body.currency },
            { account_code: `LIABILITIES.MERCHANT_PAYABLE.${merchantId}`, account_type: "LIABILITY",
              side: "C", amount_minor: merchantNetMinor, currency: body.currency },
            { account_code: `LIABILITIES.MERCHANT_RESERVE.${merchantId}`, account_type: "LIABILITY",
              side: "C", amount_minor: reserveMinor, currency: body.currency },
            { account_code: `INCOME.MDR_EARNED.PLATFORM`, account_type: "INCOME",
              side: "C", amount_minor: commissionMinor, currency: body.currency },
          ],
        });
        postedJournalId = j.journal_id;
        ledgerBreakdown = {
          gross: amountMinor.toString(), commission: commissionMinor.toString(),
          reserve: reserveMinor.toString(), net: merchantNetMinor.toString(),
        };

        // Commission accrual.
        await rows("ledger", `
          INSERT INTO commission_ledger
            (merchant_id, provider_id, txn_id, kind, rate_bps, amount_minor, currency, journal_id, status)
          VALUES ($1, $2, $3, 'PLATFORM', $4, $5, $6, $7::uuid, 'ACCRUED')
        `, [merchantId, chosen.provider, txnId, railMdrBps,
            commissionMinor.toString(), body.currency, j.journal_id]).catch(() => null);

        // Reserve hold + release calendar entry.
        const cal = await rows<{ release_id: string }>("ledger", `
          INSERT INTO reserve_release_calendar
            (merchant_id, amount_minor, currency, scheduled_at, status)
          VALUES ($1, $2, $3, now() + interval '7 days', 'SCHEDULED')
          RETURNING release_id::text
        `, [merchantId, reserveMinor.toString(), body.currency]).catch(() => []);
        await rows("ledger", `
          INSERT INTO reserve_ledger
            (tenant_id, merchant_id, source_order_id, hold_amount, hold_percent_bps,
             held_at, release_date, release_status, calendar_id, currency)
          VALUES ('tenant-default', $1, $2, $3, $4, now(),
                  now() + interval '7 days', 'HELD', $5::uuid, $6)
        `, [merchantId, txnId, reserveMinor.toString(), RESERVE_BPS,
            cal[0]?.release_id ?? null, body.currency]).catch(() => null);
      } catch (err) {
        // Journal post failure must NOT silently corrupt the lifecycle —
        // we surface it for ops to investigate but keep the order SUCCESS.
        await publish({
          eventType: "risk.alert", producer: "settlement_engine",
          entityType: "payment", entityId: orderRow.id, actorId: s.user_id,
          payload: { kind: "ledger_post_failed", reason: (err as Error).message, txn_id: txnId },
        });
      }

      await publish({
        eventType: "payment.succeeded", producer: "payment_core",
        entityType: "payment", entityId: orderRow.id, actorId: s.user_id,
        payload: { txn_id: txnId, amount_minor: String(amountMinor), provider: chosen.provider, provider_txn_id: chargeResult.providerTxnId, journal_id: postedJournalId },
      });
      await enqueueWebhook({
        merchantId, orderId: orderRow.id, eventType: "payment.success",
        payload: { txn_id: txnId, amount_minor: String(amountMinor), currency: body.currency,
                   provider: chosen.provider, provider_txn_id: chargeResult.providerTxnId, status: "SUCCESS" },
      }).catch(() => null);
    } else if (nextStatus === "FAILED") {
      await enqueueWebhook({
        merchantId, orderId: orderRow.id, eventType: "payment.failed",
        payload: { txn_id: txnId, amount_minor: String(amountMinor), currency: body.currency,
                   provider: chosen.provider, error_code: chargeResult.errorCode, status: "FAILED" },
      }).catch(() => null);
    }

    return NextResponse.json({
      order: { ...orderRow, status: nextStatus, selected_rail: chosen.provider },
      route: { selected_rank: selectedRank, provider: chosen.provider, score: chosen.score, factors: chosen.factors,
               candidates: candidates.map(c => ({ rank: c.rank, provider: c.provider, score: Number(c.score.toFixed(4)), reasoning: c.reasoning })) },
      risk: { total: risk.total, decision: risk.decision, components: risk.components },
      sca,
      gateway: gatewaySigned
        ? { signed: true, gateway: gatewaySigned.gateway, mid_code: gatewaySigned.mid_code, scheme: gatewaySigned.scheme, signature: gatewaySigned.signature }
        : { signed: false },
      ledger: postedJournalId ? { journal_id: postedJournalId, ...ledgerBreakdown } : null,
      charge: {
        outcome: chargeResult.outcome, next_state: nextStatus,
        provider_txn_id: chargeResult.providerTxnId,
        auth_status: chargeResult.authStatus,
        challenge_url: chargeResult.challengeUrl,
        response_time_ms: chargeResult.responseTimeMs,
        error_code: chargeResult.errorCode, error_message: chargeResult.errorMessage,
      },
    }, { status: 201 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
