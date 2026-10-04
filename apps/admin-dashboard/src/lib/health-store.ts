// The health engine's facts, cache and accomplishment log (merchant 0020). Rules: lib/health.ts.
//
//   computeActor(type, id)  one actor, fresh, written to the cache
//   computeAll()            every TSP, banker, merchant and integration, in batches (the cron)
//   readCached(type, ids)   the cache; a single stale actor (older than 5 minutes) is recomputed
//
// Every recomputation compares with the cached items: an item that was not DONE and now is goes
// into health_checklist_completions (SYSTEM_AUTO, with what proved it).
//
// Staff only: items may name a TSP or a gateway.

import { rows } from "@/lib/pg";
import { flowReadiness } from "@/lib/payin-flow-api";
import { merchantFlowOf } from "@/lib/payin-flow";
import { parseServices, setupItems } from "@/lib/merchant-services";
import { requiredDocuments } from "@/lib/onboarding-gates";
import type { Flow, Tsp, TspDocType, TspFacts } from "@/lib/chain";
import {
  bankerHealth, integrationFlows, integrationHealth, merchantHealth, newlyDone, tspHealth,
  type ActorType, type BankerFacts, type Band, type CallbackFacts, type GatewayAccount, type HealthItem, type HealthResult,
} from "@/lib/health";

export const HEALTH_TTL_MS = 5 * 60_000;
const BATCH = 400;
const MAX_ACTORS = 5000;

const chunk = <T,>(a: T[], n = BATCH): T[][] => { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── TSPs ────────────────────────────────────────────────────────────────────────────────────

const TSP_COLS = `t.id::text, t.code, t.name, t.legal_name, t.tsp_type, t.gateway_code, t.rbi_licence_no, t.pci_dss_cert_no,
  t.primary_contact_name, t.primary_contact_email, t.primary_contact_phone, t.compliance_officer_name, t.compliance_officer_email,
  t.allowed_flows, t.max_mids_per_banker, t.max_bankers, t.stage, t.screening_result`;

async function tspResults(ids: string[] | null): Promise<HealthResult[]> {
  const list = await rows<Tsp>("merchant", `
    SELECT ${TSP_COLS} FROM tsps t WHERE ($1::uuid[] IS NULL OR t.id = ANY($1::uuid[])) ORDER BY t.code LIMIT ${MAX_ACTORS}`, [ids]).catch(() => []);
  if (!list.length) return [];
  const tIds = list.map((t) => t.id);
  const [docs, counts] = await Promise.all([
    rows<{ tsp_id: string; doc_type: TspDocType; review: string }>("merchant", `
      SELECT DISTINCT tsp_id::text, doc_type, review FROM tsp_documents WHERE tsp_id = ANY($1::uuid[])`, [tIds]),
    rows<{ id: string; banks: number; live: number }>("merchant", `
      SELECT t.id::text,
             (SELECT COUNT(*)::int FROM tsp_banks tb WHERE tb.tsp_id = t.id AND tb.status = 'CONFIRMED') AS banks,
             (SELECT COUNT(*)::int FROM merchants m WHERE m.parent_tsp_id = t.id AND m.stage = 'LIVE') AS live
        FROM tsps t WHERE t.id = ANY($1::uuid[])`, [tIds]),
  ]);
  const facts = new Map<string, TspFacts>(tIds.map((id) => [id, { approvedDocs: [], pendingDocs: [], confirmedBanks: 0, liveBankers: 0 }]));
  for (const d of docs) {
    const f = facts.get(d.tsp_id)!;
    if (d.review === "APPROVED") f.approvedDocs.push(d.doc_type);
    if (d.review === "PENDING") f.pendingDocs.push(d.doc_type);
  }
  for (const c of counts) { const f = facts.get(c.id)!; f.confirmedBanks = c.banks; f.liveBankers = c.live; }
  return list.map((t) => tspHealth(t, facts.get(t.id)!));
}

// ── Bankers ─────────────────────────────────────────────────────────────────────────────────

interface BankerRow {
  id: string; merchant_code: string; name: string; stage: string; step_bank_verify: boolean; gstin: string | null;
  parent_tsp_id: string | null; issuing_bank_id: string | null; webhook_url: string | null;
  webhook_version: "v1" | "v2"; has_secret: boolean;
}

export interface BankerBundle {
  facts: BankerFacts;
  /** For its integrations. */
  liveKey: boolean;
  webhookVersion: "v1" | "v2";
  hasSigningSecret: boolean;
  lastPayin: { P2P: string | null; INTENT: string | null };
  lastPayout: string | null;
  ready: { p2p: boolean; intent: boolean; payout: boolean };
}

/** The callback facts: merchant 0019's verified URLs and pings when they exist, else webhook_outbox. */
async function callbackFacts(b: BankerRow[]): Promise<Map<string, CallbackFacts>> {
  const codes = b.map((x) => x.merchant_code);
  const out = new Map<string, CallbackFacts>();
  const [configs, delivered] = await Promise.all([
    rows<{ merchant_id: string }>("notification", `
      SELECT merchant_id FROM merchant_webhook_configs WHERE merchant_id = ANY($1::text[]) AND enabled AND target_url <> ''`, [codes]).catch(() => []),
    rows<{ m: string; at: string }>("notification", `
      SELECT merchant_id AS m, MAX(delivered_at) AS at FROM webhook_outbox
       WHERE merchant_id = ANY($1::text[]) AND status = 'DELIVERED' AND NOT COALESCE(is_test, false)
         AND created_at > now() - interval '7 days'
       GROUP BY 1`, [codes]).catch(() => []),
  ]);
  const cfg = new Set(configs.map((c) => c.merchant_id));
  const last = new Map(delivered.map((d) => [d.m, iso(d.at)]));
  for (const x of b)
    out.set(x.id, { urlSet: !!x.webhook_url?.trim() || cfg.has(x.merchant_code), verifiedAt: last.get(x.merchant_code) ?? null, source: "delivery" });

  // Per-banker integration tracking (merchant 0019), when it has been applied: a URL saved there
  // counts as set, and a ping answered counts as proof it is reachable.
  const has = await rows<{ urls: string | null; pings: string | null }>("merchant",
    `SELECT to_regclass('public.banker_callback_urls')::text AS urls, to_regclass('public.callback_pings')::text AS pings`).catch(() => []);
  if (has[0]?.urls) {
    const urls = await rows<{ merchant_id: string }>("merchant", `
      SELECT DISTINCT merchant_id::text FROM banker_callback_urls WHERE merchant_id::text = ANY($1::text[])`,
      [b.flatMap((x) => [x.id, x.merchant_code])]).catch(() => []);
    for (const u of urls) {
      const x = b.find((r) => r.id === u.merchant_id || r.merchant_code === u.merchant_id);
      if (x) out.get(x.id)!.urlSet = true;
    }
  }
  if (has[0]?.pings) {
    const pings = await rows<{ merchant_id: string; at: string }>("merchant", `
      SELECT merchant_id::text, MAX(at) AS at FROM (
        SELECT merchant_id, at FROM callback_pings WHERE ok AND merchant_id::text = ANY($1::text[])
        UNION ALL
        SELECT merchant_id, verified_at FROM banker_callback_urls
         WHERE status = 'VERIFIED' AND verified_at IS NOT NULL AND merchant_id::text = ANY($1::text[])
      ) x GROUP BY 1`, [b.flatMap((x) => [x.id, x.merchant_code])]).catch(() => []);
    for (const p of pings) {
      const x = b.find((r) => r.id === p.merchant_id || r.merchant_code === p.merchant_id);
      if (!x) continue;
      const f = out.get(x.id)!;
      const at = iso(p.at);
      if (at && (!f.verifiedAt || at > f.verifiedAt)) { f.verifiedAt = at; f.source = "ping"; }
    }
  }
  return out;
}

async function bankerBatch(list: BankerRow[], providers: Map<string, ProviderRow>, mapped: Map<string, string>): Promise<BankerBundle[]> {
  if (!list.length) return [];
  const ids = list.map((b) => b.id), codes = list.map((b) => b.merchant_code);
  const both = [...codes, ...ids];
  const [own, ready, payoutGw, gwVault, golive, docs, tsps, links, mids, flags, keys, payins, payouts, payable, callbacks] = await Promise.all([
    rows<{ merchant_code: string; payin_flow: string; payin_active_flow: string | null; blocked: boolean }>("merchant", `
      SELECT merchant_code, payin_flow, payin_active_flow, blocked FROM merchant_payment_config WHERE merchant_code = ANY($1::text[])`, [codes]).catch(() => []),
    flowReadiness(codes).catch(() => new Map<string, { p2p: boolean; intent: boolean }>()),
    rows<{ owner_id: string }>("checkout", `
      SELECT DISTINCT owner_id FROM credential_vault
       WHERE kind = 'mid_secret' AND owner_type = 'merchant' AND label = 'payout_gateway' AND enabled AND owner_id = ANY($1::text[])`, [codes]).catch(() => []),
    rows<{ owner_id: string; label: string }>("checkout", `
      SELECT DISTINCT owner_id, label FROM credential_vault
       WHERE kind = 'mid_secret' AND owner_type = 'merchant' AND (label = 'gateway_mid' OR label LIKE 'gateway_mid:%')
         AND enabled AND owner_id = ANY($1::text[])`, [codes]).catch(() => []),
    rows<{ merchant_id: string; gateway: string; account: string; status: "VERIFYING" | "LIVE" }>("vendorGateway", `
      SELECT merchant_id, gateway, account, status FROM gateway_golive WHERE merchant_id = ANY($1::text[])`, [codes]).catch(() => []),
    rows<{ merchant_id: string; doc_type: string }>("merchant", `
      SELECT DISTINCT merchant_id::text, doc_type FROM merchant_kyb_documents WHERE merchant_id = ANY($1::uuid[])`, [ids]).catch(() => []),
    rows<{ id: string; code: string; stage: string }>("merchant", `SELECT id::text, code, stage FROM tsps`).catch(() => []),
    rows<{ tsp_id: string; bank_id: string; status: string }>("merchant", `SELECT tsp_id::text, bank_id::text, status FROM tsp_banks`).catch(() => []),
    rows<{ merchant_id: string; flow: Flow }>("merchant", `
      SELECT DISTINCT merchant_id::text, flow FROM issued_mids WHERE status = 'ACTIVE' AND merchant_id = ANY($1::uuid[])`, [ids]).catch(() => []),
    rows<{ merchant_id: string; n: number }>("vendorGateway", `
      SELECT merchant_id, COUNT(*)::int AS n FROM payin_compliance_flags
       WHERE status IN ('OPEN','ESCALATED') AND severity <> 'INFO' AND merchant_id = ANY($1::text[]) GROUP BY 1`, [both]).catch(() => []),
    rows<{ merchant_code: string }>("checkout", `
      SELECT DISTINCT merchant_code FROM merchant_checkout_keys WHERE livemode AND merchant_code = ANY($1::text[])`, [codes]).catch(() => []),
    rows<{ merchant_id: string; channel_type: string; at: string }>("vendorGateway", `
      SELECT merchant_id, channel_type, MAX(updated_at) AS at FROM vendor_payin_orders
       WHERE status = 'SUCCESS' AND livemode AND merchant_id = ANY($1::text[]) AND updated_at > now() - interval '30 days'
       GROUP BY 1, 2`, [both]).catch(() => []),
    rows<{ merchant_id: string; at: string }>("fifo", `
      SELECT merchant_id, MAX(COALESCE(completed_at, created_at)) AS at FROM fifo_orders
       WHERE direction = 'PAYOUT' AND status = 'COMPLETED' AND COALESCE(livemode, true) AND merchant_id = ANY($1::text[])
         AND created_at > now() - interval '30 days'
       GROUP BY 1`, [codes]).catch(() => []),
    rows<{ code: string; bal: string }>("ledger", `
      SELECT a.code, COALESCE(SUM(CASE WHEN ll.side = 'C' THEN ll.amount_minor ELSE -ll.amount_minor END), 0)::text AS bal
        FROM accounts a JOIN ledger_lines ll ON ll.account_id = a.id
       WHERE a.code = ANY($1::text[]) GROUP BY a.code`, [codes.map((c) => `LIABILITIES.MERCHANT_PAYABLE.${c}`)]).catch(() => []),
    callbackFacts(list),
  ]);

  const ownFlow = new Map(own.filter((o) => o.payin_flow !== "UNSET").map((o) => [o.merchant_code, merchantFlowOf(o.payin_flow, o.payin_active_flow)]));
  const blocked = new Set(own.filter((o) => o.blocked).map((o) => o.merchant_code));
  const payoutSet = new Set(payoutGw.map((p) => p.owner_id));
  const tspById = new Map(tsps.map((t) => [t.id, t]));
  const linkOf = new Map(links.map((l) => [`${l.tsp_id}:${l.bank_id}`, l.status]));
  const keySet = new Set(keys.map((k) => k.merchant_code));
  const docMap = new Map<string, string[]>();
  for (const d of docs) docMap.set(d.merchant_id, [...(docMap.get(d.merchant_id) ?? []), d.doc_type]);
  const flowMap = new Map<string, Flow[]>();
  for (const m of mids) flowMap.set(m.merchant_id, [...(flowMap.get(m.merchant_id) ?? []), m.flow]);
  const flagN = (b: BankerRow) => flags.filter((f) => f.merchant_id === b.merchant_code || f.merchant_id === b.id).reduce((s, f) => s + f.n, 0);
  const lastPay = (b: BankerRow, ch: string) =>
    payins.filter((p) => (p.merchant_id === b.merchant_code || p.merchant_id === b.id) && p.channel_type === ch)
      .map((p) => iso(p.at)!).sort().pop() ?? null;
  const payoutAt = new Map(payouts.map((p) => [p.merchant_id, iso(p.at)]));
  const balance = new Map(payable.map((p) => [p.code.replace("LIABILITIES.MERCHANT_PAYABLE.", ""), Number(p.bal)]));

  return list.map((b): BankerBundle => {
    const providerId = mapped.get(b.id) ?? mapped.get(b.merchant_code) ?? null;
    const p = providerId ? providers.get(providerId) : undefined;
    const services = p ? parseServices(p.services) : "UNSET";
    const flow = ownFlow.get(b.merchant_code) ?? (p ? merchantFlowOf(p.payin_flow, p.payin_active_flow) : { flow: "UNSET" as const, active: null });
    const r = ready.get(b.merchant_code);
    const hasPayout = payoutSet.has(b.merchant_code);
    const tsp = b.parent_tsp_id ? tspById.get(b.parent_tsp_id) : undefined;
    const accounts: GatewayAccount[] = gwVault.filter((v) => v.owner_id === b.merchant_code).map((v) => {
      const g = golive.find((x) => x.merchant_id === b.merchant_code && x.account === v.label);
      // An account with no go-live row is not gated: every account live before the checklist.
      return { gateway: g?.gateway ?? "gateway", account: v.label, status: g?.status ?? "LIVE" };
    });
    const lastPayout = payoutAt.get(b.merchant_code) ?? null;
    const recentPayout = !!lastPayout && Date.now() - Date.parse(lastPayout) <= 7 * 86400_000;
    const facts: BankerFacts = {
      id: b.id, code: b.merchant_code, name: b.name, stage: b.stage,
      blocked: blocked.has(b.merchant_code) || (!!p && p.status !== "ACTIVE"),
      missingDocs: requiredDocuments({ gstin: b.gstin }).filter((d) => !(docMap.get(b.id) ?? []).includes(d)),
      bankVerified: b.step_bank_verify,
      chain: {
        hasTsp: !!b.parent_tsp_id, tspLive: tsp?.stage === "LIVE", hasBank: !!b.issuing_bank_id,
        bankConfirmed: !!b.parent_tsp_id && !!b.issuing_bank_id && linkOf.get(`${b.parent_tsp_id}:${b.issuing_bank_id}`) === "CONFIRMED",
        tspCode: tsp?.code ?? null,
      },
      activeMidFlows: flowMap.get(b.id) ?? [],
      services, flow,
      setup: setupItems(services, flow, { upiId: !!r?.p2p, payinGateway: !!r?.intent, payoutGateway: hasPayout }),
      gatewayAccounts: accounts,
      callback: callbacks.get(b.id) ?? { urlSet: !!b.webhook_url, verifiedAt: null, source: "delivery" },
      openComplianceFlags: flagN(b),
      payoutFunded: (balance.get(b.merchant_code) ?? 0) > 0 || recentPayout,
      providerId,
    };
    return {
      facts, liveKey: keySet.has(b.merchant_code), webhookVersion: b.webhook_version, hasSigningSecret: b.has_secret,
      lastPayin: { P2P: lastPay(b, "P2P"), INTENT: lastPay(b, "INTENT") }, lastPayout,
      ready: { p2p: !!r?.p2p, intent: !!r?.intent, payout: hasPayout },
    };
  });
}

interface ProviderRow {
  id: string; code: string; legal_name: string; status: string; kyc_status: string;
  services: string; payin_flow: string; payin_active_flow: string | null;
}

async function providerMaps(providerIds: string[] | null): Promise<{ providers: Map<string, ProviderRow>; mapped: Map<string, string> }> {
  const [providers, maps] = await Promise.all([
    rows<ProviderRow>("provider", `
      SELECT id::text, code, legal_name, status, kyc_status, services, payin_flow, payin_active_flow FROM providers
       WHERE ($1::uuid[] IS NULL OR id = ANY($1::uuid[])) ORDER BY legal_name LIMIT ${MAX_ACTORS}`, [providerIds]).catch(() => []),
    rows<{ provider_id: string; merchant_id: string }>("provider", `
      SELECT provider_id::text, merchant_id::text FROM provider_merchant_mappings
       WHERE status = 'ACTIVE' AND ($1::uuid[] IS NULL OR provider_id = ANY($1::uuid[]))`, [providerIds]).catch(() => []),
  ]);
  return { providers: new Map(providers.map((p) => [p.id, p])), mapped: new Map(maps.map((m) => [m.merchant_id, m.provider_id])) };
}

const BANKER_COLS = `id::text, merchant_code, COALESCE(NULLIF(brand_name, ''), legal_name) AS name, stage, step_bank_verify, gstin,
  parent_tsp_id::text, issuing_bank_id::text, webhook_url, webhook_version, (webhook_secret IS NOT NULL AND webhook_secret <> '') AS has_secret`;

async function bankerRows(where: string, params: unknown[]): Promise<BankerRow[]> {
  return rows<BankerRow>("merchant", `SELECT ${BANKER_COLS} FROM merchants WHERE ${where} ORDER BY created_at DESC LIMIT ${MAX_ACTORS}`, params);
}

function integrationResults(b: BankerBundle): HealthResult[] {
  return integrationFlows(b.facts.services, b.facts.flow, b.ready).map((flow) => integrationHealth({
    bankerId: b.facts.id, code: b.facts.code, stage: b.facts.stage, flow, liveKey: b.liveKey, callback: b.facts.callback,
    lastSuccessAt: flow === "PAYOUT" ? b.lastPayout : b.lastPayin[flow], webhookVersion: b.webhookVersion, hasSigningSecret: b.hasSigningSecret,
  }));
}

// ── Merchants ───────────────────────────────────────────────────────────────────────────────

async function merchantResults(providers: ProviderRow[], mapped: Map<string, string>, bankers: Map<string, { code: string; stage: string; band: Band }>): Promise<HealthResult[]> {
  if (!providers.length) return [];
  const docs = await rows<{ provider_id: string; n: number }>("provider", `
    SELECT provider_id::text, COUNT(*)::int AS n FROM provider_kyc_documents
     WHERE verified_at IS NULL AND provider_id = ANY($1::uuid[]) GROUP BY 1`, [providers.map((p) => p.id)]).catch(() => []);
  const unverified = new Map(docs.map((d) => [d.provider_id, d.n]));
  const byProvider = new Map<string, string[]>();
  for (const [bankerKey, pid] of mapped) byProvider.set(pid, [...(byProvider.get(pid) ?? []), bankerKey]);
  return providers.map((p) => merchantHealth({
    id: p.id, code: p.code, name: p.legal_name, status: p.status, kycStatus: p.kyc_status,
    services: parseServices(p.services), flow: merchantFlowOf(p.payin_flow, p.payin_active_flow),
    bankers: (byProvider.get(p.id) ?? []).map((k) => bankers.get(k)).filter((x): x is NonNullable<typeof x> => !!x)
      .map((x) => ({ id: "", ...x })),
    unverifiedDocs: unverified.get(p.id) ?? 0,
  }));
}

// ── Cache and completions ───────────────────────────────────────────────────────────────────

export interface CachedHealth {
  actor_type: ActorType; actor_id: string; label: string | null; live: boolean;
  score: number; raw_score: number; band: Band; items: HealthItem[]; computed_at: string;
  /** Older than five minutes. */
  stale: boolean;
}

const CACHE_COLS = `actor_type, actor_id, label, live, score, raw_score, band, items, computed_at,
  (computed_at < now() - interval '5 minutes') AS stale`;

/** Write results to the cache, recording every item that turned DONE. Returns the previous bands. */
export async function persist(results: HealthResult[]): Promise<Map<string, Band>> {
  const prevBands = new Map<string, Band>();
  for (const part of chunk(results)) {
    const keys = part.map((r) => `${r.type}|${r.id}`);
    const prev = await rows<{ k: string; band: Band; items: HealthItem[] }>("merchant", `
      SELECT actor_type || '|' || actor_id AS k, band, items FROM actor_health WHERE actor_type || '|' || actor_id = ANY($1::text[])`, [keys]);
    const prevMap = new Map(prev.map((p) => [p.k, p]));
    const completions: { actor_type: string; actor_id: string; item_key: string; evidence_ref: string | null }[] = [];
    for (const r of part) {
      const p = prevMap.get(`${r.type}|${r.id}`);
      if (p) prevBands.set(`${r.type}|${r.id}`, p.band);
      for (const i of newlyDone(p?.items, r.items))
        completions.push({ actor_type: r.type, actor_id: r.id, item_key: i.key, evidence_ref: i.evidence?.slice(0, 500) ?? null });
    }
    await rows("merchant", `
      INSERT INTO actor_health (actor_type, actor_id, label, live, score, raw_score, band, items, computed_at)
      SELECT x.actor_type, x.actor_id, x.label, x.live, x.score, x.raw_score, x.band, x.items, now()
        FROM jsonb_to_recordset($1::jsonb) AS x(actor_type text, actor_id text, label text, live boolean, score int, raw_score int, band text, items jsonb)
      ON CONFLICT (actor_type, actor_id) DO UPDATE SET label = EXCLUDED.label, live = EXCLUDED.live, score = EXCLUDED.score,
        raw_score = EXCLUDED.raw_score, band = EXCLUDED.band, items = EXCLUDED.items, computed_at = now()
    `, [JSON.stringify(part.map((r) => ({ actor_type: r.type, actor_id: r.id, label: r.label, live: r.live, score: r.score, raw_score: r.raw_score, band: r.band, items: r.items })))]);
    if (completions.length)
      await rows("merchant", `
        INSERT INTO health_checklist_completions (actor_type, actor_id, item_key, completed_by, method, evidence_ref)
        SELECT x.actor_type, x.actor_id, x.item_key, 'SYSTEM', 'SYSTEM_AUTO', x.evidence_ref
          FROM jsonb_to_recordset($1::jsonb) AS x(actor_type text, actor_id text, item_key text, evidence_ref text)
      `, [JSON.stringify(completions)]);
  }
  return prevBands;
}

/** One actor, computed now and written to the cache. null when there is no such actor. */
export async function computeActor(type: ActorType, id: string): Promise<HealthResult | null> {
  let out: HealthResult[] = [];
  if (type === "TSP") {
    if (!UUID.test(id)) return null;
    out = await tspResults([id]);
  } else if (type === "BANKER" || type === "INTEGRATION") {
    const key = type === "INTEGRATION" ? id.slice(0, id.lastIndexOf(":")) : id;
    const list = await bankerRows(UUID.test(key) ? `id = $1::uuid` : `merchant_code = $1`, [key]);
    if (!list.length) return null;
    const m = await rows<{ provider_id: string }>("provider", `
      SELECT provider_id::text FROM provider_merchant_mappings WHERE status = 'ACTIVE' AND merchant_id::text = ANY($1::text[]) LIMIT 1`,
      [[list[0].id, list[0].merchant_code]]).catch(() => []);
    const { providers, mapped } = await providerMaps(m[0] ? [m[0].provider_id] : []);
    const [b] = await bankerBatch(list, providers, mapped);
    const banker = bankerHealth(b.facts);
    const ints = integrationResults(b);
    await persist([banker, ...ints]);
    return type === "BANKER" ? banker : ints.find((r) => r.id === id) ?? null;
  } else if (type === "MERCHANT") {
    if (!UUID.test(id)) return null;
    const { providers, mapped } = await providerMaps([id]);
    const p = providers.get(id);
    if (!p) return null;
    const keys = [...mapped.keys()];
    const list = keys.length ? await bankerRows(`id::text = ANY($1::text[]) OR merchant_code = ANY($1::text[])`, [keys]) : [];
    const bundles = await bankerBatch(list, providers, mapped);
    const bankerRes = bundles.map((b) => bankerHealth(b.facts));
    const bands = bankerBandMap(list, bankerRes);
    out = [...bankerRes, ...bundles.flatMap(integrationResults), ...await merchantResults([p], mapped, bands)];
    await persist(out);
    return out.find((r) => r.type === "MERCHANT") ?? null;
  }
  await persist(out);
  return out.find((r) => r.type === type && r.id === id) ?? null;
}

function bankerBandMap(list: BankerRow[], res: HealthResult[]): Map<string, { code: string; stage: string; band: Band }> {
  const out = new Map<string, { code: string; stage: string; band: Band }>();
  const byId = new Map(res.map((r) => [r.id, r]));
  for (const b of list) {
    const r = byId.get(b.id);
    if (!r) continue;
    const v = { code: b.merchant_code, stage: b.stage, band: r.band };
    out.set(b.id, v); out.set(b.merchant_code, v);
  }
  return out;
}

export interface ComputeAllResult { results: HealthResult[]; previous: Map<string, Band>; counts: Record<ActorType, number> }

/** Every actor, in batches. Bounded at MAX_ACTORS of each kind. */
export async function computeAll(): Promise<ComputeAllResult> {
  const results: HealthResult[] = [];
  const previous = new Map<string, Band>();
  const keep = async (r: HealthResult[]) => { results.push(...r); for (const [k, v] of await persist(r)) previous.set(k, v); };

  await keep(await tspResults(null));
  const { providers, mapped } = await providerMaps(null);
  const list = await bankerRows("true", []);
  const bankerRes: HealthResult[] = [];
  for (const part of chunk(list)) {
    const bundles = await bankerBatch(part, providers, mapped);
    const r = bundles.map((b) => bankerHealth(b.facts));
    bankerRes.push(...r);
    await keep([...r, ...bundles.flatMap(integrationResults)]);
  }
  await keep(await merchantResults([...providers.values()], mapped, bankerBandMap(list, bankerRes)));
  const counts = { TSP: 0, BANKER: 0, MERCHANT: 0, INTEGRATION: 0 } as Record<ActorType, number>;
  for (const r of results) counts[r.type]++;
  return { results, previous, counts };
}

/**
 * Cached rows. With `ids`, those actors; else every actor of the type (optionally only some
 * bands / live ones). A single actor whose row is stale or missing is recomputed first.
 */
export async function readCached(type: ActorType, ids?: string[] | null, opts: { bands?: Band[]; liveOnly?: boolean; limit?: number } = {}): Promise<CachedHealth[]> {
  if (ids && ids.length === 1) {
    const hit = await rows<CachedHealth>("merchant", `SELECT ${CACHE_COLS} FROM actor_health WHERE actor_type = $1 AND actor_id = $2`, [type, ids[0]]);
    if (!hit.length || hit[0].stale) await computeActor(type, ids[0]).catch(() => null);
  }
  return rows<CachedHealth>("merchant", `
    SELECT ${CACHE_COLS} FROM actor_health
     WHERE actor_type = $1 AND ($2::text[] IS NULL OR actor_id = ANY($2::text[]))
       AND ($3::text[] IS NULL OR band = ANY($3::text[])) AND (NOT $4 OR live)
     ORDER BY CASE band WHEN 'BLOCKED' THEN 0 WHEN 'RED' THEN 1 WHEN 'AMBER' THEN 2 ELSE 3 END, score, actor_id
     LIMIT $5`, [type, ids?.length ? ids : null, opts.bands?.length ? opts.bands : null, !!opts.liveOnly, Math.min(opts.limit ?? MAX_ACTORS, MAX_ACTORS)]);
}

/** Live actors of every type in a bad band, for the Operations console. */
export async function alarmingActors(limit = 20): Promise<CachedHealth[]> {
  return rows<CachedHealth>("merchant", `
    SELECT ${CACHE_COLS} FROM actor_health WHERE live AND band IN ('RED','BLOCKED')
     ORDER BY CASE band WHEN 'BLOCKED' THEN 0 ELSE 1 END, score, computed_at DESC LIMIT $1`, [limit]).catch(() => []);
}

export interface Completion { item_key: string; completed_at: string; completed_by: string; method: string; evidence_ref: string | null }

export async function completions(type: ActorType, id: string, limit = 100): Promise<Completion[]> {
  return rows<Completion>("merchant", `
    SELECT item_key, completed_at, completed_by, method, evidence_ref FROM health_checklist_completions
     WHERE actor_type = $1 AND actor_id = $2 ORDER BY id DESC LIMIT $3`, [type, id, limit]);
}
