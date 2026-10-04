// A banker's integration, read and changed (merchant 0019). Rules in lib/integration, checks in
// lib/callback-verify. Staff only: nothing here is returned to a merchant or banker login, and
// the chain view names the TSP (a gateway's company).
//
// Never returns a Salt, a hint of one, or a signing secret: only whether they exist.

import { rows } from "@/lib/pg";
import { wormAppend } from "@/lib/worm";
import { assertPublicUrl } from "@/lib/safe-fetch";
import { pendingRequest, requestApproval, type Maker } from "@/lib/maker-checker";
import type { McRequest } from "@/lib/maker-checker-actions";
import type { Persona } from "@/lib/auth";
import { ChainError } from "@/lib/chain-store";
import { getCheckoutCredsStatus } from "@/lib/merchant-checkout";
import { listV2Keys } from "@/lib/v2-keys";
import { listWebhookSettings } from "@/lib/webhook-settings";
import { getBankerServices } from "@/lib/merchant-services-store";
import { getEffectiveFlow } from "@/lib/payin-flow-store";
import { allowedFlows } from "@/lib/payin-flow";
import { providerForMerchant } from "@/lib/provider-integration";
import { resolveAlert } from "@/lib/ops-alert";
import { appendIntegrationEvent, verifyCallback, type VerifyResult } from "@/lib/callback-verify";
import {
  activeFlows, bandOf, callbackAlertKey, callbackBand, callbackUrlProblem, CALLBACK_FLOWS, flowItems, overallScore, scoreOf,
  stateFromPings, usableFlowUrl, type Band, type CallbackFlow, type CallbackStatus, type ScoreItem,
} from "@/lib/integration";

export const INTEGRATION_READ: Persona[] = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "SUPPORT", "COMPLIANCE", "RISK", "FINANCE"];
export const INTEGRATION_WRITE: Persona[] = ["SUPER_ADMIN", "ADMIN"];

export const CALLBACK_RESOURCE = "banker_callback";
const resourceId = (merchantId: string, flow: CallbackFlow) => `${merchantId}:${flow}`;

interface BankerRow { id: string; merchant_code: string; name: string; stage: string; webhook_url: string | null; parent_tsp_id: string | null; issuing_bank_id: string | null }

async function mustBanker(merchantId: string): Promise<BankerRow> {
  const r = await rows<BankerRow>("merchant", `
    SELECT id::text, merchant_code, COALESCE(NULLIF(brand_name,''), legal_name, merchant_code) AS name, stage, webhook_url,
           parent_tsp_id::text, issuing_bank_id::text
      FROM merchants WHERE id = $1::uuid`, [merchantId]);
  if (!r.length) throw new ChainError(404, "NOT_FOUND", "banker not found");
  return r[0];
}

// ── The Integration tab ─────────────────────────────────────────────────────────────────────

export interface KeyStatus { exists: boolean; key: string | null; created_at: string | null; last_used_at: string | null }
export interface PingRow { id: string; flow: CallbackFlow | null; url: string; ok: boolean; http_status: number | null; response_ms: number | null; error: string | null; triggered_by: string; actor: string | null; at: string }
export interface CallbackView {
  flow: CallbackFlow | null;
  /** The URL set for this flow (null for the default row: see `effective_url`). */
  url: string | null;
  status: CallbackStatus | null;
  consecutive_failures: number;
  last_checked_at: string | null;
  last_http_status: number | null;
  last_error: string | null;
  verified_at: string | null;
  set_by: string | null;
  /** Where this flow's callbacks go now, and why. */
  effective_url: string | null;
  source: "FLOW" | "DEFAULT" | null;
  band: Band;
  pending_request: { request_id: string; action: "callback.set" | "callback.clear" } | null;
  pings: PingRow[];
}
export interface FlowScore { flow: CallbackFlow; active: boolean; score: number; band: Band; items: ScoreItem[]; payments_30d: number; successes_30d: number }
export interface IntegrationEvent { id: string; event: string; flow: string | null; detail: Record<string, unknown>; actor: string | null; at: string }

export interface Integration {
  banker: { id: string; merchant_code: string; name: string; stage: string };
  keys: { live: KeyStatus; test: KeyStatus };
  v2_keys: { live_active: number; test_active: number; last_used_at: string | null };
  webhook: { url: string | null; version: "v1" | "v2"; effective_version: "v1" | "v2"; events: string; has_secret: boolean };
  default_callback: CallbackView;
  callbacks: CallbackView[];
  services: string;
  payin_flow: string;
  scores: FlowScore[];
  overall: { score: number | null; band: Band };
  events: IntegrationEvent[];
}

async function keyStatus(code: string, livemode: boolean, created: Map<boolean, string>, used: Map<boolean, string>): Promise<KeyStatus> {
  const s = await getCheckoutCredsStatus(code, livemode).catch(() => ({ configured: false as const }));
  // Only the Key (its public handle). The Salt, and any hint of it, never leaves this function.
  return s.configured
    ? { exists: true, key: s.key, created_at: created.get(livemode) ?? null, last_used_at: used.get(livemode) ?? null }
    : { exists: false, key: null, created_at: null, last_used_at: null };
}

export async function getIntegration(merchantId: string): Promise<Integration> {
  const b = await mustBanker(merchantId);
  const code = b.merchant_code;
  const [keyRows, usedRows, v2, hooks, flowRows, pings, events, payins, payouts, services, flow] = await Promise.all([
    rows<{ livemode: boolean; created_at: string }>("checkout", `SELECT livemode, created_at FROM merchant_checkout_keys WHERE merchant_code = $1`, [code]).catch(() => []),
    rows<{ livemode: boolean; at: string }>("audit", `
      SELECT livemode, MAX(created_at) AS at FROM api_request_log
       WHERE merchant_id = $1 AND api_version = 'v1' AND created_at > now() - interval '90 days' GROUP BY livemode`, [code]).catch(() => []),
    listV2Keys(code).catch(() => []),
    listWebhookSettings([code]).catch(() => []),
    rows<{ flow: CallbackFlow; url: string | null; status: CallbackStatus; consecutive_failures: number; last_checked_at: string | null; last_http_status: number | null; last_error: string | null; verified_at: string | null; set_by: string | null }>("merchant", `
      SELECT flow, url, status, consecutive_failures, last_checked_at, last_http_status, last_error, verified_at, set_by
        FROM banker_callback_urls WHERE merchant_id = $1::uuid`, [merchantId]),
    rows<PingRow>("merchant", `
      SELECT id, flow, url, ok, http_status, response_ms, error, triggered_by, actor, at FROM (
        SELECT id::text, flow, url, ok, http_status, response_ms, error, triggered_by, actor, at,
               row_number() OVER (PARTITION BY flow ORDER BY id DESC) AS rn
          FROM callback_pings WHERE merchant_id = $1::uuid) p
       WHERE rn <= 20 ORDER BY p.id::bigint DESC`, [merchantId]),
    rows<IntegrationEvent>("merchant", `
      SELECT id::text, event, flow, detail, actor, at FROM integration_events WHERE merchant_id = $1::uuid ORDER BY integration_events.id DESC LIMIT 50`, [merchantId]),
    rows<{ channel_type: string | null; total: number; ok: number }>("vendorGateway", `
      SELECT channel_type, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status IN ('SUCCESS','SUCCEEDED'))::int AS ok
        FROM vendor_payin_orders WHERE merchant_id = $1 AND created_at > now() - interval '30 days' GROUP BY channel_type`, [code]).catch(() => []),
    rows<{ total: number; ok: number }>("fifo", `
      SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status IN ('COMPLETED','SETTLED'))::int AS ok
        FROM fifo_orders WHERE merchant_id = $1 AND direction = 'PAYOUT' AND created_at > now() - interval '30 days'`, [code]).catch(() => []),
    getBankerServices(code).catch(() => "UNSET" as const),
    getEffectiveFlow(code).catch(() => null),
  ]);

  const created = new Map(keyRows.map((k) => [k.livemode, k.created_at] as [boolean, string]));
  const used = new Map(usedRows.map((u) => [u.livemode, u.at] as [boolean, string]));
  const [live, test] = await Promise.all([keyStatus(code, true, created, used), keyStatus(code, false, created, used)]);
  const activeV2 = v2.filter((k) => k.status === "ACTIVE");
  const hook = hooks[0];
  const webhook = {
    url: hook?.callback_url ?? null, version: hook?.webhook_version ?? "v1", effective_version: hook?.effective_version ?? "v1",
    events: hook?.webhook_events ?? "ALL", has_secret: !!hook?.has_secret,
  } as Integration["webhook"];

  const pending = new Map<string, { request_id: string; action: "callback.set" | "callback.clear" }>();
  await Promise.all(CALLBACK_FLOWS.flatMap((f) => (["callback.set", "callback.clear"] as const).map(async (a) => {
    const id = await pendingRequest(CALLBACK_RESOURCE, resourceId(merchantId, f), a).catch(() => null);
    if (id) pending.set(f, { request_id: id, action: a });
  })));

  // The default URL's state is worked out from its pings.
  const defaultUrl = b.webhook_url?.trim() || null;
  const defaultPings = pings.filter((p) => p.flow === null);
  const ds = stateFromPings(defaultPings, defaultUrl);
  const defaultLast = defaultPings.find((p) => p.url === defaultUrl) ?? null;
  const defaultVerifiedAt = defaultPings.find((p) => p.url === defaultUrl && p.ok)?.at ?? null;
  const default_callback: CallbackView = {
    flow: null, url: defaultUrl, status: defaultUrl ? ds.status : null, consecutive_failures: ds.consecutive_failures,
    last_checked_at: defaultLast?.at ?? null, last_http_status: defaultLast?.http_status ?? null, last_error: defaultLast?.ok ? null : defaultLast?.error ?? null,
    verified_at: defaultVerifiedAt, set_by: null, effective_url: defaultUrl, source: defaultUrl ? "DEFAULT" : null,
    band: defaultUrl ? callbackBand(ds.status, ds.consecutive_failures) : "GREY", pending_request: null, pings: defaultPings.slice(0, 10),
  };

  const callbacks: CallbackView[] = CALLBACK_FLOWS.map((f) => {
    const r = flowRows.find((x) => x.flow === f);
    const own = usableFlowUrl(r);
    const useDefault = !own;
    return {
      flow: f, url: r?.url ?? null, status: r?.url ? r.status : null, consecutive_failures: r?.consecutive_failures ?? 0,
      last_checked_at: r?.last_checked_at ?? null, last_http_status: r?.last_http_status ?? null, last_error: r?.last_error ?? null,
      verified_at: r?.verified_at ?? null, set_by: r?.set_by ?? null,
      effective_url: own ?? defaultUrl, source: own ? "FLOW" : defaultUrl ? "DEFAULT" : null,
      band: own ? callbackBand(r!.status, r!.consecutive_failures) : useDefault ? default_callback.band : "GREY",
      pending_request: pending.get(f) ?? null,
      pings: pings.filter((p) => p.flow === f).slice(0, 10),
    };
  });

  // Scores per flow.
  const stats = (f: CallbackFlow) => f === "PAYOUT" ? { total: payouts[0]?.total ?? 0, ok: payouts[0]?.ok ?? 0 }
    : { total: payins.find((p) => p.channel_type === f)?.total ?? 0, ok: payins.find((p) => p.channel_type === f)?.ok ?? 0 };
  const seen = CALLBACK_FLOWS.filter((f) => stats(f).total > 0);
  const pf = flow ? allowedFlows(flow) : [];
  const active = activeFlows(services, pf, !flow || flow.flow === "UNSET", seen);
  const keyActive = b.stage === "LIVE" ? live.exists : live.exists || test.exists;
  const scores: FlowScore[] = CALLBACK_FLOWS.map((f) => {
    const cb = callbacks.find((c) => c.flow === f)!;
    const items = flowItems({
      keyActive, callbackUrl: cb.effective_url,
      lastVerifiedAt: cb.source === "FLOW" ? cb.verified_at : cb.source === "DEFAULT" ? default_callback.verified_at : null,
      successIn30d: stats(f).ok > 0, webhookVersion: webhook.version, hasSigningSecret: webhook.has_secret,
    });
    const score = scoreOf(items);
    return { flow: f, active: active.includes(f), score, band: bandOf(score), items, payments_30d: stats(f).total, successes_30d: stats(f).ok };
  });
  const overall = overallScore(scores.filter((s) => s.active).map((s) => s.score));

  return {
    banker: { id: b.id, merchant_code: code, name: b.name, stage: b.stage },
    keys: { live, test },
    v2_keys: {
      live_active: activeV2.filter((k) => k.livemode).length, test_active: activeV2.filter((k) => !k.livemode).length,
      last_used_at: v2.map((k) => k.last_used_at).filter(Boolean).sort().pop() ?? null,
    },
    webhook, default_callback, callbacks, services, payin_flow: flow?.flow ?? "UNSET",
    scores, overall: { score: overall, band: bandOf(overall) }, events,
  };
}

// ── Setting a per-flow URL: Maker-Checker ───────────────────────────────────────────────────

/** Raise `callback.set` (url) or `callback.clear` (null). A checker's approval applies it. */
export async function requestCallbackChange(merchantId: string, flow: CallbackFlow, url: string | null, by: Maker, notes?: string): Promise<{ request_id: string }> {
  const b = await mustBanker(merchantId);
  const cur = (await rows<{ url: string | null }>("merchant", `SELECT url FROM banker_callback_urls WHERE merchant_id = $1::uuid AND flow = $2`, [merchantId, flow]))[0];
  const rid = resourceId(merchantId, flow);
  for (const a of ["callback.set", "callback.clear"]) {
    const open = await pendingRequest(CALLBACK_RESOURCE, rid, a);
    if (open) throw new ChainError(409, "REQUEST_PENDING", "a change to this callback URL is already waiting for a checker", { request_id: open });
  }
  if (url === null) {
    if (!cur?.url) throw new ChainError(409, "NOTHING_TO_CLEAR", `no ${flow} callback URL is set`);
    const request_id = await requestApproval({
      resourceType: CALLBACK_RESOURCE, resourceId: rid, action: "callback.clear", maker: by, notes,
      payload: { merchant_id: merchantId, merchant_code: b.merchant_code, flow, url: null, previous_url: cur.url, requested_by: by.email },
      summary: `Clear the ${flow} callback URL of banker ${b.merchant_code} (its callbacks go to its default URL again)`,
    });
    return { request_id };
  }
  const u = url.trim();
  const p = callbackUrlProblem(u);
  if (p) throw new ChainError(400, "INVALID_URL", p);
  try { await assertPublicUrl(u); } catch (e) { throw new ChainError(400, "URL_NOT_PUBLIC", (e as Error).message); }
  if (cur?.url === u) throw new ChainError(409, "UNCHANGED", "that URL is already set for this flow");
  const request_id = await requestApproval({
    resourceType: CALLBACK_RESOURCE, resourceId: rid, action: "callback.set", maker: by, notes,
    payload: { merchant_id: merchantId, merchant_code: b.merchant_code, flow, url: u, previous_url: cur?.url ?? null, requested_by: by.email },
    summary: `Set the ${flow} callback URL of banker ${b.merchant_code} to ${u}`,
  });
  return { request_id };
}

/** `callback.set` approved: the row is written PENDING and checked at once. */
export async function applyCallbackSet(r: McRequest, checker: Maker): Promise<unknown> {
  const { merchant_id, flow, url } = r.payload as { merchant_id: string; flow: CallbackFlow; url: string };
  if (!(CALLBACK_FLOWS as readonly string[]).includes(flow) || typeof url !== "string" || callbackUrlProblem(url))
    throw new ChainError(400, "INVALID", "the request carries no valid flow and URL");
  await mustBanker(merchant_id);
  // Guarded: a request applied once is not applied again.
  const w = await rows<{ flow: string }>("merchant", `
    INSERT INTO banker_callback_urls (merchant_id, flow, url, status, set_by, request_id, updated_at)
    VALUES ($1::uuid, $2, $3, 'PENDING', $4, $5::uuid, now())
    ON CONFLICT (merchant_id, flow) DO UPDATE SET
      url = EXCLUDED.url, status = 'PENDING', consecutive_failures = 0, last_checked_at = NULL, last_http_status = NULL,
      last_error = NULL, verified_at = NULL, set_by = EXCLUDED.set_by, request_id = EXCLUDED.request_id, updated_at = now()
     WHERE banker_callback_urls.request_id IS DISTINCT FROM EXCLUDED.request_id
    RETURNING flow`, [merchant_id, flow, url, r.payload.requested_by ?? checker.email, r.request_id]);
  if (!w.length) return { already_applied: true };
  await appendIntegrationEvent(merchant_id, "callback_url_set", {
    flow, actor: checker.email, detail: { url, previous_url: r.payload.previous_url ?? null, requested_by: r.payload.requested_by ?? null, request_id: r.request_id },
  }).catch(() => {});
  await wormAppend({ actorId: checker.id, actorEmail: checker.email, action: "callback.set.applied", resourceType: CALLBACK_RESOURCE,
    resourceId: r.resource_id, before: { url: r.payload.previous_url ?? null }, after: { url } }).catch(() => {});
  await resolveAlert(callbackAlertKey(String(r.payload.merchant_code ?? ""), flow)).catch(() => {});
  let check: VerifyResult | { error: string };
  try { check = await verifyCallback({ merchantId: merchant_id, flow, triggeredBy: "MANUAL", actor: checker.email }); }
  catch (e) { check = { error: (e as Error).message }; }
  return { flow, url, status: "PENDING", check };
}

/** `callback.clear` approved: the flow's callbacks go to the default URL again. */
export async function applyCallbackClear(r: McRequest, checker: Maker): Promise<unknown> {
  const { merchant_id, flow } = r.payload as { merchant_id: string; flow: CallbackFlow };
  const w = await rows<{ flow: string }>("merchant", `
    UPDATE banker_callback_urls SET url = NULL, status = 'PENDING', consecutive_failures = 0, last_checked_at = NULL,
           last_http_status = NULL, last_error = NULL, verified_at = NULL, set_by = $3, request_id = $4::uuid, updated_at = now()
     WHERE merchant_id = $1::uuid AND flow = $2 AND url IS NOT NULL RETURNING flow`,
    [merchant_id, flow, r.payload.requested_by ?? checker.email, r.request_id]);
  if (!w.length) return { already_applied: true };
  await appendIntegrationEvent(merchant_id, "callback_url_cleared", {
    flow, actor: checker.email, detail: { previous_url: r.payload.previous_url ?? null, requested_by: r.payload.requested_by ?? null, request_id: r.request_id },
  }).catch(() => {});
  await wormAppend({ actorId: checker.id, actorEmail: checker.email, action: "callback.clear.applied", resourceType: CALLBACK_RESOURCE,
    resourceId: r.resource_id, before: { url: r.payload.previous_url ?? null }, after: { url: null } }).catch(() => {});
  await resolveAlert(callbackAlertKey(String(r.payload.merchant_code ?? ""), flow)).catch(() => {});
  return { flow, url: null };
}

// ── The chain: Bank → TSP → Banker → Katana → Merchant ──────────────────────────────────────

export interface ChainNode { kind: "BANK" | "TSP" | "BANKER" | "KATANA" | "MERCHANT"; title: string; label: string; sub: string; band: Band; href: string | null }
export interface ChainFlow { flow: CallbackFlow; active: boolean; mids_active: number; mids_pending: number; mid_band: Band; callback_status: CallbackStatus | null; callback_source: "FLOW" | "DEFAULT" | null; callback_band: Band; score: number; score_band: Band }
export interface BankerChainView { banker: { id: string; code: string; name: string; stage: string }; nodes: ChainNode[]; flows: ChainFlow[] }
export interface ChainView { kind: "banker" | "provider"; provider: { id: string; code: string; name: string } | null; bankers: BankerChainView[] }

const stageBand = (s: string | null | undefined, live: string, red: string[]): Band =>
  !s ? "GREY" : s === live ? "GREEN" : red.includes(s) ? "RED" : "AMBER";

async function bankerChainView(merchantId: string, provider: { id: string; code: string; name: string; status: string; services: string } | null): Promise<BankerChainView> {
  const b = await mustBanker(merchantId);
  const [tsp, bank, link, mids, integ] = await Promise.all([
    b.parent_tsp_id ? rows<{ id: string; code: string; name: string; stage: string }>("merchant", `SELECT id::text, code, name, stage FROM tsps WHERE id = $1::uuid`, [b.parent_tsp_id]) : Promise.resolve([]),
    b.issuing_bank_id ? rows<{ id: string; code: string; name: string; status: string }>("merchant", `SELECT id::text, code, name, status FROM banks WHERE id = $1::uuid`, [b.issuing_bank_id]) : Promise.resolve([]),
    b.parent_tsp_id && b.issuing_bank_id ? rows<{ status: string }>("merchant", `SELECT status FROM tsp_banks WHERE tsp_id = $1::uuid AND bank_id = $2::uuid`, [b.parent_tsp_id, b.issuing_bank_id]) : Promise.resolve([]),
    rows<{ flow: CallbackFlow; status: string; n: number }>("merchant", `
      SELECT flow, status, COUNT(*)::int AS n FROM issued_mids WHERE merchant_id = $1::uuid AND status IN ('ACTIVE','PENDING_APPROVAL') GROUP BY flow, status`, [merchantId]),
    getIntegration(merchantId),
  ]);
  const t = tsp[0], k = bank[0], l = link[0]?.status ?? null;
  const bankBand: Band = !k ? "GREY" : k.status !== "ACTIVE" || l === "ENDED" ? "RED" : l === "CONFIRMED" ? "GREEN" : "AMBER";
  const nodes: ChainNode[] = [
    { kind: "BANK", title: "Bank", label: k ? k.name : "No issuing bank", sub: k ? `${k.code} · ${l ? `link ${l.toLowerCase()}` : "not linked to the TSP"}` : "Choose one on the MIDs tab", band: bankBand, href: "/banks" },
    { kind: "TSP", title: "TSP", label: t ? t.name : "No TSP", sub: t ? `${t.code} · ${t.stage}` : "Choose one on the MIDs tab", band: stageBand(t?.stage, "LIVE", ["SUSPENDED", "REJECTED"]), href: t ? `/tsps/${t.id}` : null },
    { kind: "BANKER", title: "Banker", label: b.name, sub: `${b.merchant_code} · ${b.stage}`, band: stageBand(b.stage, "LIVE", ["SUSPENDED", "TERMINATED", "REJECTED"]), href: `/bankers/${b.id}` },
    { kind: "KATANA", title: "Katana", label: "Integration", sub: integ.overall.score == null ? "no flow in use" : `score ${integ.overall.score}`, band: integ.overall.band, href: `/bankers/${b.id}?tab=integration` },
    { kind: "MERCHANT", title: "Merchant", label: provider ? provider.name : "No merchant", sub: provider ? `${provider.code} · ${provider.status}` : "not mapped to a merchant",
      band: !provider ? "GREY" : provider.status === "ACTIVE" ? "GREEN" : provider.status === "TERMINATED" ? "RED" : "AMBER", href: provider ? `/merchants/${provider.id}` : null },
  ];
  const flows: ChainFlow[] = integ.scores.map((s) => {
    const a = mids.find((m) => m.flow === s.flow && m.status === "ACTIVE")?.n ?? 0;
    const p = mids.find((m) => m.flow === s.flow && m.status === "PENDING_APPROVAL")?.n ?? 0;
    const cb = integ.callbacks.find((c) => c.flow === s.flow)!;
    const st = cb.source === "FLOW" ? cb.status : cb.source === "DEFAULT" ? integ.default_callback.status : null;
    return {
      flow: s.flow, active: s.active, mids_active: a, mids_pending: p,
      // A P2P pay-in lands on the banker's own UPI ID and needs no bank MID (lib/chain midGate).
      mid_band: a > 0 ? "GREEN" : p > 0 ? "AMBER" : s.active && s.flow !== "P2P" ? "RED" : "GREY",
      callback_status: st, callback_source: cb.source, callback_band: cb.band, score: s.score, score_band: s.band,
    };
  });
  return { banker: { id: b.id, code: b.merchant_code, name: b.name, stage: b.stage }, nodes, flows };
}

async function providerRow(providerId: string) {
  const r = await rows<{ id: string; code: string; name: string; status: string; services: string }>("provider", `
    SELECT id::text, code, legal_name AS name, status, COALESCE(services, 'UNSET') AS services FROM providers WHERE id = $1::uuid`, [providerId]).catch(() => []);
  return r[0] ?? null;
}

export async function chainForBanker(merchantId: string): Promise<ChainView> {
  const b = await mustBanker(merchantId);
  const pid = await providerForMerchant(b.merchant_code).catch(() => null);
  const p = pid ? await providerRow(pid) : null;
  return { kind: "banker", provider: p ? { id: p.id, code: p.code, name: p.name } : null, bankers: [await bankerChainView(merchantId, p)] };
}

export async function chainForProvider(providerId: string): Promise<ChainView> {
  const p = await providerRow(providerId);
  if (!p) throw new ChainError(404, "NOT_FOUND", "merchant not found");
  const map = await rows<{ merchant_id: string }>("provider", `
    SELECT merchant_id::text AS merchant_id FROM provider_merchant_mappings WHERE provider_id = $1::uuid AND status = 'ACTIVE'`, [providerId]);
  const ids = map.map((m) => m.merchant_id);
  const bankers = ids.length ? await rows<{ id: string }>("merchant", `
    SELECT id::text FROM merchants WHERE id::text = ANY($1::text[]) OR merchant_code = ANY($1::text[]) ORDER BY merchant_code`, [ids]) : [];
  return { kind: "provider", provider: { id: p.id, code: p.code, name: p.name }, bankers: await Promise.all(bankers.map((x) => bankerChainView(x.id, p))) };
}
