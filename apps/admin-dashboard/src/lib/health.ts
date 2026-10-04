// The health engine's rules: one checklist per actor, and the score and band it comes to.
// Pure; the facts are read by lib/health-store, which also caches the result (merchant 0020).
//
//   score = required items done / required items × 100 (an optional item missing does not
//   lower it; lib/chain healthScore). GREEN ≥ 90, AMBER ≥ 70, RED < 70 (lib/chain healthBand).
//   BLOCKED: a CRITICAL item is missing. The score is then shown as 0; raw_score keeps the
//   done / required figure.
//
// Actors: TSP (lib/chain tspChecklist), BANKER (`merchants` row), MERCHANT (`providers` row)
// and INTEGRATION (one banker on one flow, id "<banker code>:<FLOW>").
//
// Staff only: an item may name a TSP or a gateway. Nothing here is shown to a merchant.

import {
  healthBand, healthScore, midGate, tspChecklist,
  type Flow, type HealthBand as ChainBand, type ItemState, type MidGateFacts, type Tsp, type TspFacts,
} from "@/lib/chain";
import type { SetupItem } from "@/lib/merchant-services";
import type { MerchantServicesSetting } from "@/lib/merchant-services";
import type { MerchantFlow } from "@/lib/payin-flow";

export const ACTOR_TYPES = ["TSP", "BANKER", "MERCHANT", "INTEGRATION"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
export const isActorType = (v: unknown): v is ActorType => (ACTOR_TYPES as readonly unknown[]).includes(v);

export type Band = ChainBand | "BLOCKED";
export const BANDS: Band[] = ["GREEN", "AMBER", "RED", "BLOCKED"];

/** lib/chain's ChecklistItem shape, without the TSP stage, plus what a person can do about it. */
export interface HealthItem {
  key: string;
  label: string;
  state: ItemState;
  /** Missing it blocks the actor (BLOCKED, score 0). */
  critical: boolean;
  /** What to do when it is missing. */
  action?: string;
  /** Where to do it. */
  href?: string;
  /** What proved it done: recorded as the completion's evidence when it turns DONE. */
  evidence?: string;
}

export interface HealthResult {
  type: ActorType;
  id: string;
  label: string;
  /** The actor is LIVE: only these raise alerts. */
  live: boolean;
  score: number;
  raw_score: number;
  band: Band;
  items: HealthItem[];
}

const st = (ok: boolean, optional = false): ItemState => (ok ? "DONE" : optional ? "OPTIONAL_MISSING" : "MISSING");

/** Score and band of a checklist. A critical item missing is BLOCKED and scores 0. */
export function grade(items: HealthItem[]): { score: number; raw_score: number; band: Band } {
  const raw = healthScore(items.map((i) => ({ key: i.key, label: i.label, state: i.state, needed_for: "APPLICATION" as const })));
  if (items.some((i) => i.critical && i.state === "MISSING")) return { score: 0, raw_score: raw, band: "BLOCKED" };
  return { score: raw, raw_score: raw, band: healthBand(raw) };
}

export function result(type: ActorType, id: string, label: string, live: boolean, items: HealthItem[]): HealthResult {
  return { type, id, label, live, items, ...grade(items) };
}

/** Bad enough to raise an alert (when live). */
export const isAlarming = (b: Band) => b === "RED" || b === "BLOCKED";

// ── TSP ─────────────────────────────────────────────────────────────────────────────────────

/** lib/chain's TSP checklist, plus "not suspended or rejected" as the one critical item. */
export function tspHealth(t: Tsp, f: TspFacts): HealthResult {
  const href = `/tsps/${t.id}`;
  const items: HealthItem[] = tspChecklist(t, f).map((i) => ({
    key: i.key, label: i.label, state: i.state, critical: false, action: i.action, href,
  }));
  items.unshift({
    key: "standing", label: "Not suspended or rejected", state: st(t.stage !== "SUSPENDED" && t.stage !== "REJECTED"),
    critical: true, action: "Reactivate the TSP or close it", href, evidence: `stage ${t.stage}`,
  });
  return result("TSP", t.id, t.code, t.stage === "LIVE", items);
}

// ── Banker ──────────────────────────────────────────────────────────────────────────────────

export interface GatewayAccount { gateway: string; account: string; status: "VERIFYING" | "LIVE" }

export interface CallbackFacts {
  /** A callback URL is saved for the banker. */
  urlSet: boolean;
  /** Last time the URL was proved reachable (a ping answered, or a callback delivered). */
  verifiedAt: string | null;
  /** What proved it: "ping" (merchant 0019 callback_pings) or "delivery" (webhook_outbox). */
  source: "ping" | "delivery";
}

export interface BankerFacts {
  id: string;
  code: string;
  name: string;
  stage: string;
  /** merchant_payment_config.blocked, or its merchant suspended / terminated. */
  blocked: boolean;
  /** Required KYB document types not uploaded (lib/onboarding-gates requiredDocuments). */
  missingDocs: string[];
  bankVerified: boolean;
  chain: { hasTsp: boolean; tspLive: boolean; hasBank: boolean; bankConfirmed: boolean; tspCode: string | null };
  activeMidFlows: Flow[];
  /** Its merchant's services and the banker's effective flow. */
  services: MerchantServicesSetting;
  flow: MerchantFlow;
  /** lib/merchant-services setupItems for that choice. */
  setup: SetupItem[];
  gatewayAccounts: GatewayAccount[];
  callback: CallbackFacts;
  openComplianceFlags: number;
  /** Payable balance above zero, or a payout completed in the last 7 days. */
  payoutFunded: boolean;
  /** Has a merchant (providers row) it is mapped under. */
  providerId: string | null;
}

export const CALLBACK_FRESH_MS = 24 * 3600_000;
export const fresh = (at: string | null, now: number, ms = CALLBACK_FRESH_MS) => !!at && now - Date.parse(at) <= ms;

/** The MID gate's view of the merchant's flow (lib/chain midGate). */
function midFacts(f: BankerFacts): MidGateFacts {
  return {
    hasTsp: f.chain.hasTsp, hasBank: f.chain.hasBank, activeFlows: f.activeMidFlows,
    services: f.services, payinFlow: f.flow.flow,
  };
}

export function bankerHealth(f: BankerFacts, now = Date.now()): HealthResult {
  const href = `/bankers/${f.id}`;
  const items: HealthItem[] = [];
  items.push({ key: "not_blocked", label: "Not blocked or suspended", critical: true,
    state: st(!f.blocked && f.stage !== "SUSPENDED" && f.stage !== "TERMINATED" && f.stage !== "REJECTED"),
    action: "Unblock the banker, or its merchant", href, evidence: `stage ${f.stage}` });
  items.push({ key: "kyb_documents", label: "KYB documents uploaded", critical: false, state: st(f.missingDocs.length === 0),
    action: f.missingDocs.length ? `Upload: ${f.missingDocs.join(", ")}` : undefined, href, evidence: "DOCUMENTS gate pass" });
  items.push({ key: "bank_verify", label: "Bank verification step done", critical: false, state: st(f.bankVerified),
    action: "Complete the Bank verify step", href, evidence: "step_bank_verify" });
  items.push({ key: "chain", label: "On a live TSP with a confirmed issuing bank", critical: false,
    state: st(f.chain.hasTsp && f.chain.tspLive && f.chain.hasBank && f.chain.bankConfirmed),
    action: !f.chain.hasTsp ? "Put the banker on a TSP" : !f.chain.tspLive ? "The banker's TSP is not live"
      : !f.chain.hasBank ? "Choose the issuing bank" : "The issuing bank has not confirmed the TSP",
    href: `${href}?tab=mids`, evidence: f.chain.tspCode ? `TSP ${f.chain.tspCode}` : undefined });
  const gate = midGate(midFacts(f));
  if (f.chain.hasTsp && f.chain.hasBank) {
    items.push({ key: "mids", label: "Active MID for each flow that needs one", critical: false,
      state: gate.result === "FAIL" ? "MISSING" : gate.result === "REVIEW" ? "OPTIONAL_MISSING" : "DONE",
      action: gate.missing.length ? `Record and approve a ${gate.missing.join(" / ")} MID` : gate.summary,
      href: `${href}?tab=mids`, evidence: gate.summary });
  }
  for (const s of f.setup) {
    items.push({ key: `setup_${s.key}`, label: s.label, state: s.state, critical: s.state === "MISSING",
      action: s.hint, href: s.key === "P2P_UPI_ID" ? `${href}?tab=p2p` : s.key === "INTENT_GATEWAY" ? `${href}?tab=intent`
        : s.key === "PAYOUT_GATEWAY" ? `${href}?tab=payouts` : f.providerId ? `/merchants/${f.providerId}` : href });
  }
  if (f.gatewayAccounts.length) {
    const verifying = f.gatewayAccounts.filter((a) => a.status !== "LIVE");
    items.push({ key: "gateway_golive", label: "Gateway accounts past go-live verification", critical: false,
      state: st(verifying.length === 0),
      action: verifying.length ? `Finish go-live for ${verifying.map((a) => `${a.gateway} (${a.account})`).join(", ")}` : undefined,
      href: "/gateway-golive", evidence: `${f.gatewayAccounts.length} account(s) LIVE` });
  }
  items.push({ key: "callback", label: "Callback URL set and reached in the last 24 h", critical: false,
    state: st(f.callback.urlSet && fresh(f.callback.verifiedAt, now)),
    action: !f.callback.urlSet ? "Save the banker's callback URL" : "No callback reached the banker's server in 24 h: check it",
    href: `${href}?tab=developer`,
    evidence: f.callback.verifiedAt ? `${f.callback.source === "ping" ? "ping answered" : "callback delivered"} ${f.callback.verifiedAt}` : undefined });
  items.push({ key: "compliance", label: "No open compliance flags", critical: false, state: st(f.openComplianceFlags === 0),
    action: `${f.openComplianceFlags} open flag(s) to review`, href: "/risk", evidence: "no OPEN / ESCALATED flags" });
  if (f.services !== "PAYIN") {
    const needed = f.services === "PAYOUT" || f.services === "BOTH";
    items.push({ key: "payout_funds", label: "Payout balance funded", critical: false, state: st(f.payoutFunded, !needed),
      action: "Fund the banker's payout balance", href: `${href}?tab=payouts`, evidence: "payable balance or recent payout" });
  }
  return result("BANKER", f.id, f.code, f.stage === "LIVE", items);
}

// ── Merchant (providers row) ────────────────────────────────────────────────────────────────

export interface MerchantFacts {
  id: string;
  code: string;
  name: string;
  status: string;
  kycStatus: string;
  services: MerchantServicesSetting;
  flow: MerchantFlow;
  /** Its bankers' results (BANKER), and their stage. */
  bankers: { id: string; code: string; stage: string; band: Band }[];
  /** KYC documents uploaded and not yet verified. */
  unverifiedDocs: number;
}

export function merchantHealth(m: MerchantFacts): HealthResult {
  const href = `/merchants/${m.id}`;
  const live = m.bankers.filter((b) => b.stage === "LIVE");
  const sick = live.filter((b) => isAlarming(b.band));
  const chosen = m.services !== "UNSET" && (m.services === "PAYOUT" || m.flow.flow !== "UNSET");
  const kybIssue = m.kycStatus === "REJECTED" || m.kycStatus === "EXPIRED" || m.unverifiedDocs > 0;
  const items: HealthItem[] = [
    { key: "active", label: "Merchant active", critical: true, state: st(m.status === "ACTIVE"),
      action: "Reactivate the merchant", href, evidence: `status ${m.status}` },
    { key: "kyc", label: "KYC approved", critical: false, state: st(m.kycStatus === "APPROVED"),
      action: `KYC is ${m.kycStatus}: review it`, href, evidence: "kyc_status APPROVED" },
    { key: "choice", label: "Services and pay-in flow chosen", critical: false, state: st(chosen),
      action: "Choose services and flow", href: "/merchant-readiness", evidence: `${m.services} / ${m.flow.flow}` },
    { key: "bankers", label: "At least one banker", critical: false, state: st(m.bankers.length > 0),
      action: "Map or onboard a banker", href: `${href}?tab=merchants`, evidence: `${m.bankers.length} banker(s)` },
    { key: "bankers_healthy", label: "Every live banker GREEN or AMBER", critical: false,
      state: live.length ? st(sick.length === 0) : "OPTIONAL_MISSING",
      action: live.length ? `Fix ${sick.map((b) => b.code).join(", ")}` : "No live banker yet",
      href: `${href}?tab=merchants`, evidence: `${live.length} live banker(s) healthy` },
    { key: "kyb_issues", label: "No open KYB issues", critical: false, state: st(!kybIssue),
      action: m.unverifiedDocs ? `${m.unverifiedDocs} document(s) to verify` : `KYC is ${m.kycStatus}`, href: `${href}?tab=docs` },
  ];
  return result("MERCHANT", m.id, m.code, m.status === "ACTIVE" && live.length > 0, items);
}

// ── Integration (one banker on one flow) ────────────────────────────────────────────────────

export type IntegrationFlow = "P2P" | "INTENT" | "PAYOUT";

/** The flows a banker is integrated on: what its merchant chose, or (nothing chosen) what is set up. */
export function integrationFlows(services: MerchantServicesSetting, flow: MerchantFlow, ready: { p2p: boolean; intent: boolean; payout: boolean }): IntegrationFlow[] {
  const out: IntegrationFlow[] = [];
  if (services !== "PAYOUT") {
    if (flow.flow === "P2P" || flow.flow === "BOTH" || (flow.flow === "UNSET" && ready.p2p)) out.push("P2P");
    if (flow.flow === "INTENT" || flow.flow === "BOTH" || (flow.flow === "UNSET" && ready.intent)) out.push("INTENT");
  }
  if (services === "PAYOUT" || services === "BOTH" || (services === "UNSET" && ready.payout)) out.push("PAYOUT");
  return out;
}

export interface IntegrationFacts {
  bankerId: string;
  code: string;
  stage: string;
  flow: IntegrationFlow;
  /** A live Key exists for the banker. */
  liveKey: boolean;
  callback: CallbackFacts;
  /** Last successful live payment on this flow (payout for PAYOUT). */
  lastSuccessAt: string | null;
  webhookVersion: "v1" | "v2";
  hasSigningSecret: boolean;
}

export const SUCCESS_WINDOW_MS = 30 * 86400_000;

export function integrationHealth(f: IntegrationFacts, now = Date.now()): HealthResult {
  const href = `/bankers/${f.bankerId}?tab=developer`;
  const payout = f.flow === "PAYOUT";
  const items: HealthItem[] = [
    { key: "key", label: "Live Key active", critical: true, state: st(f.liveKey),
      action: "Generate the banker's live Key + Salt", href, evidence: "live checkout key" },
    { key: "callback", label: "Callback reached in the last 24 h", critical: false,
      state: st(f.callback.urlSet && fresh(f.callback.verifiedAt, now)),
      action: f.callback.urlSet ? "Check the banker's server answers callbacks" : "Save the banker's callback URL", href,
      evidence: f.callback.verifiedAt ? `${f.callback.source} ${f.callback.verifiedAt}` : undefined },
    { key: "success_30d", label: payout ? "A payout sent in the last 30 days" : "A successful payment in the last 30 days",
      critical: false, state: st(fresh(f.lastSuccessAt, now, SUCCESS_WINDOW_MS)),
      action: payout ? "No payout completed in 30 days" : "No paid order on this flow in 30 days",
      href: `/bankers/${f.bankerId}?tab=${payout ? "payouts" : f.flow === "P2P" ? "p2p" : "intent"}`,
      evidence: f.lastSuccessAt ? `last success ${f.lastSuccessAt}` : undefined },
    { key: "signing_secret", label: "Webhook signing secret (v2)", critical: false,
      state: st(f.webhookVersion === "v1" || f.hasSigningSecret),
      action: "Create the banker's v2 signing secret", href, evidence: f.webhookVersion === "v1" ? "v1 callbacks" : "v2 secret set" },
  ];
  return result("INTEGRATION", `${f.code}:${f.flow}`, `${f.code} · ${f.flow}`, f.stage === "LIVE", items);
}

// ── What changed between two computations ───────────────────────────────────────────────────

/** Items that were not DONE before and are now: each is a completion to record. */
export function newlyDone(before: HealthItem[] | null | undefined, after: HealthItem[]): HealthItem[] {
  if (!before) return [];
  const prev = new Map(before.map((i) => [i.key, i.state]));
  return after.filter((i) => i.state === "DONE" && prev.has(i.key) && prev.get(i.key) !== "DONE");
}

/** The once-a-day AMBER digest is sent from 09:00 IST. */
export function istHour(now = new Date()): number {
  return new Date(now.getTime() + 330 * 60_000).getUTCHours();
}
