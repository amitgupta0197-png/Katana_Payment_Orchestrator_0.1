// PARTNERS: payment aggregators that onboard their own merchants on Katana. PURE: no database,
// no imports from the order core, so the API, the screens and the tests share one set of rules.
//
// A partner is a Katana merchant (a `providers` row) with a partner record (vendorGateway 0044).
// Its bankers are where the money lands and it is settled as any merchant is. Its merchants
// ("sub-merchants") hold no money and have no banker of their own: every partner order names one,
// and Katana enforces its status, flows and limits before the order reaches the pay-in core.
//
// The module stands on its own. Partner orders reach the pay-in core through one optional input
// (lib/katana-order `partner`), and an exclusive partner's bankers take nothing else.

export const PARTNER_STATUSES = ["ACTIVE", "SUSPENDED"] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export const SUB_STATUSES = ["PENDING", "ACTIVE", "REJECTED", "SUSPENDED"] as const;
export type SubStatus = (typeof SUB_STATUSES)[number];

export const SUB_FLOWS = ["P2P", "INTENT", "BOTH"] as const;
export type SubFlows = (typeof SUB_FLOWS)[number];

export type OrderFlowName = "P2P" | "INTENT";

export const SUB_STATUS_WORDS: Record<SubStatus, string> = {
  PENDING: "Waiting for review", ACTIVE: "Active", REJECTED: "Rejected", SUSPENDED: "Suspended",
};

// ── Sub-merchant status ──────────────────────────────────────────────────────────

export const SUB_ACTIONS = ["approve", "reject", "suspend", "reactivate", "resubmit"] as const;
export type SubAction = (typeof SUB_ACTIONS)[number];

const MOVES: Record<SubAction, { from: SubStatus[]; to: SubStatus }> = {
  approve:    { from: ["PENDING"], to: "ACTIVE" },
  reject:     { from: ["PENDING"], to: "REJECTED" },
  suspend:    { from: ["ACTIVE", "PENDING"], to: "SUSPENDED" },
  reactivate: { from: ["SUSPENDED"], to: "ACTIVE" },
  resubmit:   { from: ["REJECTED"], to: "PENDING" },
};

const DONE: Record<SubAction, string> = {
  approve: "approved", reject: "rejected", suspend: "suspended", reactivate: "reactivated", resubmit: "sent for review again",
};

/** Who may take each action: staff decide; a partner may only send a rejected one back for review. */
export const STAFF_ONLY_ACTIONS: SubAction[] = ["approve", "reject", "suspend", "reactivate"];

/** The status an action moves a sub-merchant to, or why it cannot. */
export function moveSub(from: SubStatus, action: SubAction): { ok: true; to: SubStatus } | { ok: false; error: string } {
  const m = MOVES[action];
  if (!m) return { ok: false, error: `unknown action ${action}` };
  if (!m.from.includes(from)) return { ok: false, error: `a sub-merchant that is ${SUB_STATUS_WORDS[from].toLowerCase()} cannot be ${DONE[action]}` };
  return { ok: true, to: m.to };
}

/** A reject or suspend needs a reason the partner can read. */
export function actionNeedsReason(action: SubAction): boolean {
  return action === "reject" || action === "suspend";
}

// ── Sub-merchant details ─────────────────────────────────────────────────────────

export interface SubMerchantInput {
  external_id: string;
  legal_name: string;
  display_name?: string | null;
  business_type?: string | null;
  category?: string | null;
  pan?: string | null;
  gstin?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  address?: string | null;
  flows?: SubFlows;
  min_amount?: number | null;   // rupees
  max_amount?: number | null;
  daily_amount?: number | null;
}

export interface FieldProblem { field: string; message: string }

const EXTERNAL_ID = /^[A-Za-z0-9._:-]{1,60}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9]{10,15}$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const tidy = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t : null;
};
const upper = (v: string | null | undefined): string | null => tidy(v)?.replace(/\s+/g, "").toUpperCase() ?? null;

/**
 * The sub-merchant's details, cleaned, or the first field that is wrong. `partial` checks only the
 * fields present (an update); a new sub-merchant needs an external id, a legal name and a PAN.
 * The amounts are rupees, at most two places.
 */
export function cleanSubMerchant(input: Partial<SubMerchantInput>, partial = false): { ok: true; value: Partial<SubMerchantInput> } | { ok: false; problem: FieldProblem } {
  const out: Partial<SubMerchantInput> = {};
  const bad = (field: string, message: string) => ({ ok: false as const, problem: { field, message } });
  const has = (k: keyof SubMerchantInput) => !partial || Object.prototype.hasOwnProperty.call(input, k);

  if (has("external_id")) {
    const v = tidy(input.external_id);
    if (!v || !EXTERNAL_ID.test(v)) return bad("external_id", "external_id is your own id for the merchant: 1 to 60 letters, digits or . _ : -");
    out.external_id = v;
  }
  if (has("legal_name")) {
    const v = tidy(input.legal_name);
    if (!v || v.length < 2 || v.length > 200) return bad("legal_name", "legal_name is the registered business name, 2 to 200 characters");
    out.legal_name = v;
  }
  for (const k of ["display_name", "business_type", "category", "address"] as const) {
    if (!has(k)) continue;
    const v = tidy(input[k] as string | null);
    if (v && v.length > (k === "address" ? 500 : 120)) return bad(k, `${k} is too long`);
    out[k] = v;
  }
  if (has("pan")) {
    const v = upper(input.pan);
    if (!v && !partial) return bad("pan", "pan is required: the business's PAN, e.g. ABCDE1234F");
    if (v && !PAN.test(v)) return bad("pan", "pan is not a valid PAN (5 letters, 4 digits, 1 letter)");
    out.pan = v;
  }
  if (has("gstin")) {
    const v = upper(input.gstin);
    if (v && !GSTIN.test(v)) return bad("gstin", "gstin is not a valid GSTIN (15 characters)");
    out.gstin = v;
  }
  // A GSTIN carries the PAN it was issued to (characters 3 to 12).
  const pan = out.pan ?? null, gstin = out.gstin ?? null;
  if (pan && gstin && gstin.slice(2, 12) !== pan) return bad("gstin", "gstin was not issued to this PAN");
  if (has("email")) {
    const v = tidy(input.email);
    if (v && !EMAIL.test(v)) return bad("email", "email is not a valid address");
    out.email = v?.toLowerCase() ?? null;
  }
  if (has("phone")) {
    const v = tidy(input.phone)?.replace(/[\s-]/g, "") ?? null;
    if (v && !PHONE.test(v)) return bad("phone", "phone is 10 to 15 digits, optionally starting with +");
    out.phone = v;
  }
  if (has("website")) {
    const v = tidy(input.website);
    if (v && (!/^https?:\/\/[^\s]+$/i.test(v) || v.length > 300)) return bad("website", "website must be an http(s) address");
    out.website = v;
  }
  if (has("flows")) {
    const v = input.flows ?? "BOTH";
    if (!SUB_FLOWS.includes(v)) return bad("flows", "flows is P2P, INTENT or BOTH");
    out.flows = v;
  }
  for (const k of ["min_amount", "max_amount", "daily_amount"] as const) {
    if (!has(k)) continue;
    const v = input[k];
    if (v == null) { out[k] = null; continue; }
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || Math.round(v * 100) !== v * 100 || v > 1e10)
      return bad(k, `${k} is a positive amount in rupees, at most two decimal places`);
    out[k] = v;
  }
  return { ok: true, value: out };
}

/** The amounts after an update, checked together. */
export function limitsProblem(l: { min_amount?: number | null; max_amount?: number | null; daily_amount?: number | null }): FieldProblem | null {
  if (l.min_amount != null && l.max_amount != null && l.min_amount > l.max_amount)
    return { field: "min_amount", message: "min_amount is more than max_amount" };
  if (l.max_amount != null && l.daily_amount != null && l.max_amount > l.daily_amount)
    return { field: "max_amount", message: "max_amount is more than daily_amount" };
  return null;
}

/** Whether the partner's own merchant setting allows these flows. `merchantFlow` null = no flow chosen yet. */
export function flowsWithinPartner(flows: SubFlows, merchantFlow: "P2P" | "INTENT" | "BOTH" | null): boolean {
  if (!merchantFlow || merchantFlow === "BOTH") return true;
  return flows === merchantFlow;
}

// ── Orders ───────────────────────────────────────────────────────────────────────

export interface PartnerLike { status: PartnerStatus }
export interface SubLike {
  status: SubStatus;
  flows: SubFlows;
  min_amount: number | null;
  max_amount: number | null;
  daily_amount: number | null;
}

export type PartnerRefusalCode =
  | "PARTNER_SUSPENDED" | "SUB_MERCHANT_NOT_ACTIVE" | "FLOW_NOT_ALLOWED"
  | "SUB_MERCHANT_MIN_AMOUNT" | "SUB_MERCHANT_MAX_AMOUNT" | "SUB_MERCHANT_DAILY_LIMIT";

export interface PartnerRefusal { code: PartnerRefusalCode; message: string; limit?: number; actual?: number }

/**
 * The flow a partner order takes: the one it asks for, which must be one the sub-merchant is on;
 * else the sub-merchant's only flow; else null (the partner's own default decides, as for any merchant).
 */
export function orderFlowFor(flows: SubFlows, requested: OrderFlowName | null | undefined): { ok: true; flow: OrderFlowName | null } | { ok: false; refusal: PartnerRefusal } {
  if (requested) {
    if (flows !== "BOTH" && flows !== requested)
      return { ok: false, refusal: { code: "FLOW_NOT_ALLOWED", message: `this sub-merchant is on ${flows} only` } };
    return { ok: true, flow: requested };
  }
  return { ok: true, flow: flows === "BOTH" ? null : flows };
}

/**
 * Why a partner order may not be created for this sub-merchant, or null. A test order needs a
 * sub-merchant that is not rejected or suspended (one waiting for review may test); a live order
 * needs an ACTIVE one. The day's total is the sub-merchant's live orders today (India day), failed
 * and expired left out, and is checked for live orders only.
 */
export function partnerOrderRefusal(a: {
  partner: PartnerLike; sub: SubLike; livemode: boolean; amount: number; todayAmount: number;
}): PartnerRefusal | null {
  if (a.partner.status !== "ACTIVE") return { code: "PARTNER_SUSPENDED", message: "the partner account is suspended" };
  const s = a.sub;
  if (a.livemode ? s.status !== "ACTIVE" : !(s.status === "ACTIVE" || s.status === "PENDING"))
    return { code: "SUB_MERCHANT_NOT_ACTIVE", message: s.status === "PENDING"
      ? "this sub-merchant is waiting for review; it can take test orders until it is approved"
      : `this sub-merchant is ${SUB_STATUS_WORDS[s.status].toLowerCase()} and takes no orders` };
  if (s.min_amount != null && a.amount < s.min_amount)
    return { code: "SUB_MERCHANT_MIN_AMOUNT", message: `the amount is under this sub-merchant's minimum of ${s.min_amount}`, limit: s.min_amount, actual: a.amount };
  if (s.max_amount != null && a.amount > s.max_amount)
    return { code: "SUB_MERCHANT_MAX_AMOUNT", message: `the amount is over this sub-merchant's maximum of ${s.max_amount}`, limit: s.max_amount, actual: a.amount };
  if (a.livemode && s.daily_amount != null && a.todayAmount + a.amount > s.daily_amount)
    return { code: "SUB_MERCHANT_DAILY_LIMIT", message: `the order would pass this sub-merchant's limit of ${s.daily_amount} for the day`, limit: s.daily_amount, actual: a.todayAmount + a.amount };
  return null;
}

/**
 * The signer of a partner's orders (vendor_payin_orders.signed_by): a reference is unique per
 * partner and mode, whichever banker took the order (the 0042 index on COALESCE(signed_by, merchant_id)).
 * Never a banker code, so it can never be mistaken for one.
 */
export function partnerSigner(partnerId: string): string {
  return `partner:${partnerId}`;
}

/** The outbox owner of a partner's webhook deliveries (lib/webhook-outbox signs them with the partner's secret). */
export const PARTNER_OUTBOX_PREFIX = "partner:";
export function partnerIdFromOutbox(merchantId: string): string | null {
  return merchantId.startsWith(PARTNER_OUTBOX_PREFIX) ? merchantId.slice(PARTNER_OUTBOX_PREFIX.length) : null;
}

// ── Keys ─────────────────────────────────────────────────────────────────────────

/** The mode a partner key claims, or null when it is not a partner key. */
export function partnerKeyMode(key: string): boolean | null {
  if (key.startsWith("pk_live_")) return true;
  if (key.startsWith("pk_test_")) return false;
  return null;
}

// ── Codes ────────────────────────────────────────────────────────────────────────

export function newSubCode(random: string): string {
  return `SM_${random.replace(/[^A-Za-z0-9]/g, "").slice(0, 14).toUpperCase()}`;
}

export function partnerCodeProblem(code: string): string | null {
  return /^[A-Z0-9_-]{2,20}$/.test(code) ? null : "code is 2 to 20 capital letters, digits, _ or -";
}
