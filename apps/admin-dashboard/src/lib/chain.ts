// The chain a banker's MIDs come from: Bank → TSP → Banker (merchant 0018). Pure rules; the
// facts are read by lib/chain-store.
//
//   Bank   issues MIDs.
//   TSP    the payment aggregator, gateway or acquiring-bank arm a bank issues them through.
//          Onboarded APPLICATION → KYB_PENDING → SCREENING → BANK_VERIFY → CONFIG → LIVE;
//          going live, suspending and reactivating need a second person (lib/maker-checker).
//   Banker is on one LIVE TSP, with an issuing bank the TSP is confirmed for, and holds the
//          MIDs that bank issued it, one row each (flow, value, dates, limits), made ACTIVE by a
//          second person.
//
// Staff only: a TSP is a gateway's company and is never named to a merchant. Nothing here
// routes money; the MID switch still decides which processor account takes an order.

export const FLOWS = ["INTENT", "P2P", "PAYOUT"] as const;
export type Flow = (typeof FLOWS)[number];

export const TSP_TYPES = ["PAYMENT_AGGREGATOR", "PAYMENT_GATEWAY", "ACQUIRING_BANK_ARM"] as const;
export type TspType = (typeof TSP_TYPES)[number];

export const BANK_TYPES = ["PUBLIC", "PRIVATE", "COOPERATIVE", "FOREIGN", "SMALL_FINANCE", "PAYMENTS"] as const;

export const TSP_STAGES = ["APPLICATION", "KYB_PENDING", "SCREENING", "BANK_VERIFY", "CONFIG", "LIVE"] as const;
export type TspStage = (typeof TSP_STAGES)[number] | "SUSPENDED" | "REJECTED";

export const TSP_DOC_TYPES = ["INCORPORATION", "RBI_LICENCE", "PCI_DSS", "BOARD_RESOLUTION", "BANK_AUTHORISATION", "OTHER"] as const;
export type TspDocType = (typeof TSP_DOC_TYPES)[number];

/** A code is upper-case letters, digits and _, 2–20 long, starting with a letter. */
export const CODE_RE = /^[A-Z][A-Z0-9_]{1,19}$/;

export interface Tsp {
  id: string;
  code: string;
  name: string;
  legal_name: string | null;
  tsp_type: TspType;
  gateway_code: string | null;
  rbi_licence_no: string | null;
  pci_dss_cert_no: string | null;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  primary_contact_phone: string | null;
  compliance_officer_name: string | null;
  compliance_officer_email: string | null;
  allowed_flows: Flow[];
  max_mids_per_banker: number | null;
  max_bankers: number | null;
  stage: TspStage;
  screening_result: "CLEAR" | "REVIEW" | "HIT" | null;
}

/** What the store knows about a TSP besides its own row. */
export interface TspFacts {
  /** Document types with at least one APPROVED copy. */
  approvedDocs: TspDocType[];
  /** Document types uploaded and not yet reviewed. */
  pendingDocs: TspDocType[];
  confirmedBanks: number;
  liveBankers: number;
}

export type ItemState = "DONE" | "MISSING" | "OPTIONAL_MISSING";
export interface ChecklistItem {
  key: string;
  label: string;
  state: ItemState;
  /** The stage whose step needs it; later stages' items are shown but do not hold this one up. */
  needed_for: TspStage;
  /** What to do when it is missing. */
  action?: string;
}

/** The documents a TSP must have approved. An acquiring bank's arm works under its bank's licence. */
export function requiredTspDocs(t: Pick<Tsp, "tsp_type">): TspDocType[] {
  return t.tsp_type === "ACQUIRING_BANK_ARM" ? ["INCORPORATION"] : ["INCORPORATION", "RBI_LICENCE"];
}

const filled = (v: string | null | undefined) => !!v && v.trim().length > 0;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The TSP's checklist: everything onboarding needs, then what keeps it healthy. */
export function tspChecklist(t: Tsp, f: TspFacts): ChecklistItem[] {
  const st = (ok: boolean, optional = false): ItemState => (ok ? "DONE" : optional ? "OPTIONAL_MISSING" : "MISSING");
  const licenceNeeded = t.tsp_type !== "ACQUIRING_BANK_ARM";
  const items: ChecklistItem[] = [
    { key: "details", label: "Name, legal name and type", state: st(filled(t.name) && filled(t.legal_name)), needed_for: "APPLICATION", action: "Fill in the legal name" },
    { key: "contact", label: "Primary contact email", state: st(filled(t.primary_contact_email)), needed_for: "APPLICATION", action: "Add the primary contact" },
    { key: "compliance_officer", label: "Compliance officer email", state: st(filled(t.compliance_officer_email)), needed_for: "APPLICATION", action: "Add the compliance officer" },
    { key: "rbi_licence_no", label: "RBI licence number", state: st(!licenceNeeded || filled(t.rbi_licence_no)), needed_for: "APPLICATION", action: "Add the RBI licence number" },
  ];
  for (const d of requiredTspDocs(t))
    items.push({ key: `doc_${d}`, label: `${cap(docLabel(d))} approved`, state: st(f.approvedDocs.includes(d)), needed_for: "KYB_PENDING",
      action: f.pendingDocs.includes(d) ? `Review the uploaded ${docLabel(d)}` : `Upload the ${docLabel(d)}` });
  items.push({ key: "doc_PCI_DSS", label: "PCI-DSS certificate", state: st(f.approvedDocs.includes("PCI_DSS"), true), needed_for: "KYB_PENDING", action: "Upload the PCI-DSS certificate" });
  items.push(
    { key: "screening", label: "Sanctions screening clear", state: st(t.screening_result === "CLEAR"), needed_for: "SCREENING", action: "Run screening" },
    { key: "bank", label: "At least one bank confirmed the TSP", state: st(f.confirmedBanks > 0), needed_for: "BANK_VERIFY", action: "Confirm a bank association" },
    { key: "flows", label: "Flows it may issue MIDs for", state: st(t.allowed_flows.length > 0), needed_for: "CONFIG", action: "Choose Intent / P2P / Payout" },
    { key: "mid_quota", label: "MID quota per banker", state: st((t.max_mids_per_banker ?? 0) > 0), needed_for: "CONFIG", action: "Set the MIDs a banker may hold" },
    { key: "live_banker", label: "At least one live banker", state: st(f.liveBankers > 0, true), needed_for: "LIVE" },
  );
  return items;
}

export function docLabel(d: TspDocType): string {
  return ({ INCORPORATION: "certificate of incorporation", RBI_LICENCE: "RBI licence", PCI_DSS: "PCI-DSS certificate",
    BOARD_RESOLUTION: "board resolution", BANK_AUTHORISATION: "bank authorisation letter", OTHER: "document" } as const)[d];
}

/** The stage a TSP's next step moves it to. */
export const TSP_NEXT: Partial<Record<TspStage, TspStage>> = {
  APPLICATION: "KYB_PENDING", KYB_PENDING: "SCREENING", SCREENING: "BANK_VERIFY", BANK_VERIFY: "CONFIG", CONFIG: "LIVE",
};

/** The checklist items that must be done before leaving `stage` (its own and every earlier one). */
export function blockingItems(stage: TspStage, items: ChecklistItem[]): ChecklistItem[] {
  const order = TSP_STAGES as readonly string[];
  const at = order.indexOf(stage);
  if (at < 0) return [];
  return items.filter((i) => i.state === "MISSING" && order.indexOf(i.needed_for) >= 0 && order.indexOf(i.needed_for) <= at);
}

/**
 * Whether a TSP may take its next step, and where to. Screening is run by the step itself, so a
 * TSP at SCREENING is not held up by the screening item; going live from CONFIG goes through
 * Maker-Checker (`second_person`).
 */
export function tspNextStep(t: Pick<Tsp, "stage">, items: ChecklistItem[]):
  | { ok: true; to: TspStage; second_person: boolean }
  | { ok: false; code: "NO_NEXT_STEP" | "CHECKLIST_INCOMPLETE"; message: string; missing: ChecklistItem[] } {
  const to = TSP_NEXT[t.stage];
  if (!to) return { ok: false, code: "NO_NEXT_STEP", message: `a TSP in ${t.stage} has no next step`, missing: [] };
  const missing = blockingItems(t.stage, items).filter((i) => !(t.stage === "SCREENING" && i.key === "screening"));
  if (missing.length) return { ok: false, code: "CHECKLIST_INCOMPLETE", message: `missing: ${missing.map((m) => m.label).join("; ")}`, missing };
  return { ok: true, to, second_person: to === "LIVE" };
}

/** 0–100: required items done over required items. An optional item missing does not lower it. */
export function healthScore(items: ChecklistItem[]): number {
  const required = items.filter((i) => i.state !== "OPTIONAL_MISSING");
  if (!required.length) return 100;
  return Math.round((required.filter((i) => i.state === "DONE").length / required.length) * 100);
}

export type HealthBand = "GREEN" | "AMBER" | "RED";
export function healthBand(score: number): HealthBand {
  return score >= 90 ? "GREEN" : score >= 70 ? "AMBER" : "RED";
}

// ── TSP form ────────────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface TspInput {
  code?: string;
  name?: string;
  legal_name?: string | null;
  tsp_type?: string;
  gateway_code?: string | null;
  rbi_licence_no?: string | null;
  pci_dss_cert_no?: string | null;
  primary_contact_name?: string | null;
  primary_contact_email?: string | null;
  primary_contact_phone?: string | null;
  compliance_officer_name?: string | null;
  compliance_officer_email?: string | null;
  allowed_flows?: string[];
  max_mids_per_banker?: number | null;
  max_bankers?: number | null;
  notes?: string | null;
}

/** First problem with a TSP create (`creating`) or edit, or null. */
export function tspInputProblem(i: TspInput, creating: boolean): string | null {
  if (creating) {
    if (!i.code || !CODE_RE.test(i.code)) return "code: 2–20 upper-case letters, digits or _, starting with a letter";
    if (!i.name?.trim()) return "name is required";
    if (!i.tsp_type) return "tsp_type is required";
  }
  if (i.name !== undefined && !i.name.trim()) return "name cannot be empty";
  if (i.tsp_type !== undefined && !(TSP_TYPES as readonly string[]).includes(i.tsp_type)) return `tsp_type must be one of ${TSP_TYPES.join(", ")}`;
  for (const k of ["primary_contact_email", "compliance_officer_email"] as const)
    if (filled(i[k]) && !EMAIL_RE.test(i[k]!.trim())) return `${k} is not an email address`;
  if (i.allowed_flows) {
    const bad = i.allowed_flows.filter((f) => !(FLOWS as readonly string[]).includes(f));
    if (bad.length) return `allowed_flows: unknown ${bad.join(", ")}`;
  }
  for (const k of ["max_mids_per_banker", "max_bankers"] as const) {
    const v = i[k];
    if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 1 || v > 10_000)) return `${k} must be a whole number from 1 to 10000`;
  }
  return null;
}

/** Fields that may not change once a TSP is LIVE without a second person: its permissions. */
export const TSP_LOCKED_WHEN_LIVE = ["allowed_flows", "max_mids_per_banker", "max_bankers", "tsp_type"] as const;

// ── Bank form ───────────────────────────────────────────────────────────────────────────────

export interface BankInput {
  code?: string;
  name?: string;
  bank_type?: string;
  settlement_account?: string | null;
  neft_enabled?: boolean;
  imps_enabled?: boolean;
  upi_enabled?: boolean;
  contact_email?: string | null;
  status?: string;
}

export function bankInputProblem(i: BankInput, creating: boolean): string | null {
  if (creating) {
    if (!i.code || !CODE_RE.test(i.code)) return "code: 2–20 upper-case letters, digits or _, starting with a letter";
    if (!i.name?.trim()) return "name is required";
    if (!i.bank_type) return "bank_type is required";
  }
  if (i.name !== undefined && !i.name.trim()) return "name cannot be empty";
  if (i.bank_type !== undefined && !(BANK_TYPES as readonly string[]).includes(i.bank_type)) return `bank_type must be one of ${BANK_TYPES.join(", ")}`;
  if (i.status !== undefined && i.status !== "ACTIVE" && i.status !== "INACTIVE") return "status must be ACTIVE or INACTIVE";
  if (filled(i.contact_email) && !EMAIL_RE.test(i.contact_email!.trim())) return "contact_email is not an email address";
  if (filled(i.settlement_account) && !/^[0-9]{6,20}$/.test(i.settlement_account!.replace(/\s/g, ""))) return "settlement_account: 6–20 digits";
  return null;
}

/** An account number shown as its last four digits. */
export function maskAccount(n: string | null | undefined): string | null {
  if (!n) return null;
  const d = n.replace(/\s/g, "");
  return d.length <= 4 ? "••••" : `••••${d.slice(-4)}`;
}

// ── A banker's place in the chain ───────────────────────────────────────────────────────────

export interface ChainFacts {
  tsp: Pick<Tsp, "id" | "stage" | "max_bankers"> | null;
  /** The TSP's link to the chosen bank: null when there is none. */
  bankLink: "PENDING" | "CONFIRMED" | "ENDED" | null;
  bankActive: boolean;
  /** Bankers already on the TSP, this one not counted. */
  otherBankersOnTsp: number;
  /** ACTIVE or pending MIDs this banker holds on a different TSP. */
  midsOnOtherTsp: number;
}

export type Refusal = { code: string; message: string };

/** Why a banker may not be put on this TSP and bank, or null. */
export function chainRefusal(f: ChainFacts): Refusal | null {
  if (!f.tsp) return { code: "TSP_NOT_FOUND", message: "no such TSP" };
  if (f.tsp.stage !== "LIVE") return { code: "TSP_NOT_LIVE", message: `the TSP is ${f.tsp.stage}; only a LIVE TSP takes bankers` };
  if (!f.bankActive) return { code: "BANK_INACTIVE", message: "the bank is not active" };
  if (f.bankLink !== "CONFIRMED") return { code: "BANK_NOT_ON_TSP", message: "the bank has not confirmed this TSP" };
  if (f.tsp.max_bankers != null && f.otherBankersOnTsp >= f.tsp.max_bankers)
    return { code: "TSP_BANKER_CAP", message: `the TSP already has ${f.otherBankersOnTsp} of its ${f.tsp.max_bankers} bankers` };
  if (f.midsOnOtherTsp > 0)
    return { code: "MIDS_ON_OTHER_TSP", message: `the banker holds ${f.midsOnOtherTsp} MID(s) on its current TSP; deactivate them first` };
  return null;
}

// ── Issued MIDs ─────────────────────────────────────────────────────────────────────────────

export type MidStatus = "PENDING_APPROVAL" | "ACTIVE" | "INACTIVE" | "REJECTED";

export interface MidInput {
  flow?: string;
  mid_value?: string;
  issued_on?: string | null;
  expires_on?: string | null;
  daily_limit?: number | null;
  monthly_limit?: number | null;
  currency?: string;
  notes?: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function midInputProblem(i: MidInput): string | null {
  if (!i.flow || !(FLOWS as readonly string[]).includes(i.flow)) return `flow must be one of ${FLOWS.join(", ")}`;
  const v = i.mid_value?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_\-./]{3,63}$/.test(v)) return "mid_value: 4–64 letters, digits, _ - . /";
  for (const k of ["issued_on", "expires_on"] as const) {
    const d = i[k];
    if (d && (!DATE_RE.test(d) || Number.isNaN(Date.parse(d)))) return `${k} must be a date (YYYY-MM-DD)`;
  }
  if (i.issued_on && i.expires_on && i.expires_on < i.issued_on) return "expires_on is before issued_on";
  for (const k of ["daily_limit", "monthly_limit"] as const) {
    const n = i[k];
    if (n !== undefined && n !== null && (!Number.isFinite(n) || n <= 0)) return `${k} must be above zero`;
  }
  if (i.daily_limit && i.monthly_limit && i.daily_limit > i.monthly_limit) return "daily_limit is above monthly_limit";
  if (i.currency !== undefined && !/^[A-Z]{3}$/.test(i.currency)) return "currency: a three-letter code";
  return null;
}

export interface MidIssueFacts {
  banker: { parent_tsp_id: string | null; issuing_bank_id: string | null };
  tsp: Pick<Tsp, "stage" | "allowed_flows" | "max_mids_per_banker"> | null;
  bankLink: "PENDING" | "CONFIRMED" | "ENDED" | null;
  /** The banker's ACTIVE and PENDING_APPROVAL MIDs. */
  openMids: number;
}

/** Why a MID may not be recorded for this banker, or null. */
export function midIssueRefusal(f: MidIssueFacts, flow: Flow): Refusal | null {
  if (!f.banker.parent_tsp_id || !f.tsp) return { code: "NO_TSP", message: "put the banker on a TSP first" };
  if (!f.banker.issuing_bank_id) return { code: "NO_BANK", message: "choose the banker's issuing bank first" };
  if (f.tsp.stage !== "LIVE") return { code: "TSP_NOT_LIVE", message: `the banker's TSP is ${f.tsp.stage}` };
  if (f.bankLink !== "CONFIRMED") return { code: "BANK_NOT_ON_TSP", message: "the issuing bank has not confirmed the banker's TSP" };
  if (!f.tsp.allowed_flows.includes(flow)) return { code: "FLOW_NOT_ALLOWED", message: `the TSP may not issue ${flow} MIDs` };
  if (f.tsp.max_mids_per_banker != null && f.openMids >= f.tsp.max_mids_per_banker)
    return { code: "MID_QUOTA_REACHED", message: `the banker holds ${f.openMids} of the ${f.tsp.max_mids_per_banker} MIDs its TSP allows` };
  return null;
}

/** A MID number shown with its last four characters only. */
export function maskMid(v: string): string {
  return v.length <= 4 ? v : `${"•".repeat(Math.min(v.length - 4, 6))}${v.slice(-4)}`;
}

// ── The MID_ISSUANCE onboarding step ────────────────────────────────────────────────────────

export interface MidGateFacts {
  hasTsp: boolean;
  hasBank: boolean;
  /** Flows of the banker's ACTIVE MIDs. */
  activeFlows: Flow[];
  /** What its merchant was onboarded for (lib/merchant-services, lib/payin-flow). */
  services: "PAYIN" | "PAYOUT" | "BOTH" | "UNSET";
  payinFlow: "P2P" | "INTENT" | "BOTH" | "UNSET";
}

/**
 * The MID_ISSUANCE gate. FAIL (a Super Admin may override with a note) when the banker has no
 * TSP or issuing bank, or takes Intent pay-ins with no ACTIVE Intent MID. A P2P pay-in lands
 * on the banker's own UPI ID, so it needs no bank MID; a missing payout MID, or a merchant
 * nobody chose for, is only flagged (REVIEW).
 */
export function midGate(f: MidGateFacts): { result: "PASS" | "REVIEW" | "FAIL"; summary: string; missing: Flow[] } {
  if (!f.hasTsp) return { result: "FAIL", summary: "the banker is on no TSP", missing: [] };
  if (!f.hasBank) return { result: "FAIL", summary: "the banker has no issuing bank", missing: [] };
  const payin = f.services !== "PAYOUT";
  const payout = f.services === "PAYOUT" || f.services === "BOTH";
  const intent = payin && (f.payinFlow === "INTENT" || f.payinFlow === "BOTH");
  const has = (x: Flow) => f.activeFlows.includes(x);
  if (intent && !has("INTENT")) return { result: "FAIL", summary: "takes Intent pay-ins but has no active Intent MID", missing: ["INTENT"] };
  if (payout && !has("PAYOUT")) return { result: "REVIEW", summary: "sends payouts but has no active Payout MID", missing: ["PAYOUT"] };
  if (f.services === "UNSET" || (payin && f.payinFlow === "UNSET"))
    return f.activeFlows.length
      ? { result: "PASS", summary: `active MIDs: ${[...new Set(f.activeFlows)].join(", ")}`, missing: [] }
      : { result: "REVIEW", summary: "nothing chosen for its merchant and no active MID", missing: [] };
  return { result: "PASS", summary: f.activeFlows.length ? `active MIDs: ${[...new Set(f.activeFlows)].join(", ")}` : "P2P only: pays to the banker's own UPI ID", missing: [] };
}
