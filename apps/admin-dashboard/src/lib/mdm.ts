// Master Data Management (MDM): the rules. Pure: no database, safe to import in the browser.
//
// Each master type (BANK, TSP, BANKER, MERCHANT, CHANNEL) has a template: its field schema.
//   - CORE fields are the real table columns. They are written here, read from the migrations
//     (merchant 0018 banks / tsps, merchant 0001… merchants, provider 0001… providers,
//     routingEngine 0000… rails). They are LOCKED: a template version must carry every one of
//     them exactly as defined here, and they stay edited on their own existing pages.
//   - CUSTOM fields are added by staff, optional, and kept in the row's `extra jsonb` column
//     (merchant 0022, provider 0022, routingEngine 0005). A custom field is never removed once
//     it has been in a version: it is RETIRED, its stored values kept and shown read-only.
//
// When a migration adds a column to one of these tables, add it to CORE here. The stored
// versions' copy of the core fields is informational only: the code's CORE is the truth, and
// `coreLockProblem` compares a proposal against it, never against the previous version.
//
// Storage and approvals are in lib/mdm-store.ts. Staff only.

export const MASTER_TYPES = ["BANK", "TSP", "BANKER", "MERCHANT", "CHANNEL"] as const;
export type MasterType = (typeof MASTER_TYPES)[number];

export const CUSTOM_FIELD_TYPES = ["string", "number", "boolean", "date", "enum", "email", "url"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
export type CoreFieldType = CustomFieldType | "uuid" | "timestamp" | "list";
export type FieldType = CoreFieldType;

export interface MdmField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** Core fields only: a real table column, locked. */
  core?: boolean;
  /** Core fields only: the value is sealed or personal; shown as set / not set, never read. */
  sensitive?: boolean;
  notes?: string;
  help?: string;
  options?: string[];
  /** string / email / url: a regular expression the whole value must match. */
  regex?: string;
  /** number: value bounds. string / email / url: length bounds. */
  min?: number;
  max?: number;
  /** Custom only: kept with its values, shown read-only, no longer edited. */
  retired?: boolean;
  /** Custom only: a change to its value goes through Maker-Checker (`mdm.extra_update`). */
  requires_approval?: boolean;
}

export interface MasterDef {
  type: MasterType;
  label: string;
  plural: string;
  /** The database key (lib/pg) and table that hold the records. */
  db: "merchant" | "provider" | "routingEngine";
  table: string;
  /** Core columns shown in the master list, in order. */
  summary: string[];
  /** Core columns searched (ILIKE) in the master list. */
  search: string[];
  /** Core column that names a record. */
  title: string;
  /** Where its core fields are edited. */
  editHref: (id: string) => string;
  description: string;
}

const c = (key: string, label: string, type: CoreFieldType, required: boolean, extra: Partial<MdmField> = {}): MdmField =>
  ({ key, label, type, required, core: true, ...extra });

const ts = (key: string, label: string, required = true) => c(key, label, "timestamp", required);

export const CORE: Record<MasterType, MdmField[]> = {
  BANK: [
    c("id", "ID", "uuid", true, { notes: "Primary key" }),
    c("code", "Code", "string", true, { notes: "Unique; ^[A-Z][A-Z0-9_]{1,19}$ (IFSC prefix)" }),
    c("name", "Name", "string", true),
    c("bank_type", "Bank type", "enum", true, { options: ["PUBLIC", "PRIVATE", "COOPERATIVE", "FOREIGN", "SMALL_FINANCE", "PAYMENTS"] }),
    c("settlement_account", "Settlement account", "string", false, { sensitive: true, notes: "Sealed (lib/sealed-text); never searched in SQL" }),
    c("neft_enabled", "NEFT enabled", "boolean", true, { notes: "Default true" }),
    c("imps_enabled", "IMPS enabled", "boolean", true, { notes: "Default true" }),
    c("upi_enabled", "UPI enabled", "boolean", true, { notes: "Default true" }),
    c("contact_email", "Contact email", "email", false),
    c("status", "Status", "enum", true, { options: ["ACTIVE", "INACTIVE"], notes: "Default ACTIVE" }),
    c("created_by", "Created by", "string", false),
    ts("created_at", "Created at"),
    ts("updated_at", "Updated at"),
  ],
  TSP: [
    c("id", "ID", "uuid", true, { notes: "Primary key" }),
    c("code", "Code", "string", true, { notes: "Unique; ^[A-Z][A-Z0-9_]{1,19}$" }),
    c("name", "Name", "string", true),
    c("legal_name", "Legal name", "string", false),
    c("tsp_type", "TSP type", "enum", true, { options: ["PAYMENT_AGGREGATOR", "PAYMENT_GATEWAY", "ACQUIRING_BANK_ARM"] }),
    c("gateway_code", "Gateway code", "string", false, { notes: "Connector it runs (lib/pg-catalog)" }),
    c("rbi_licence_no", "RBI licence no.", "string", false),
    c("pci_dss_cert_no", "PCI DSS certificate no.", "string", false),
    c("primary_contact_name", "Primary contact", "string", false),
    c("primary_contact_email", "Primary contact email", "email", false),
    c("primary_contact_phone", "Primary contact phone", "string", false),
    c("compliance_officer_name", "Compliance officer", "string", false),
    c("compliance_officer_email", "Compliance officer email", "email", false),
    c("allowed_flows", "Allowed flows", "list", true, { options: ["INTENT", "P2P", "PAYOUT"], notes: "Default empty" }),
    c("max_mids_per_banker", "Max MIDs per banker", "number", false, { min: 1 }),
    c("max_bankers", "Max bankers", "number", false, { min: 1 }),
    c("stage", "Stage", "enum", true, { options: ["APPLICATION", "KYB_PENDING", "SCREENING", "BANK_VERIFY", "CONFIG", "LIVE", "SUSPENDED", "REJECTED"], notes: "Moved by the onboarding steps; LIVE / SUSPENDED through Maker-Checker" }),
    c("screening_result", "Screening result", "enum", false, { options: ["CLEAR", "REVIEW", "HIT"] }),
    c("screened_by", "Screened by", "string", false),
    ts("screened_at", "Screened at", false),
    c("notes", "Notes", "string", false),
    c("created_by", "Created by", "string", false),
    ts("created_at", "Created at"),
    ts("updated_at", "Updated at"),
  ],
  BANKER: [
    c("id", "ID", "uuid", true, { notes: "Primary key" }),
    c("tenant_id", "Tenant", "string", true, { notes: "Default tenant-default" }),
    c("merchant_code", "Banker code", "string", true, { notes: "Unique" }),
    c("legal_name", "Legal name", "string", true),
    c("brand_name", "Brand name", "string", false),
    c("business_type", "Business type", "string", false),
    c("category_mcc", "Category (MCC)", "string", false),
    c("contact_email", "Contact email", "email", true),
    c("contact_phone", "Contact phone", "string", false),
    c("website", "Website", "url", false),
    c("registered_address", "Registered address", "string", false),
    c("stage", "Stage", "enum", true, { options: ["APPLICATION", "DOCS_PENDING", "SCREENING", "BANK_VERIFY", "MID_ISSUANCE", "CONFIG", "IN_REVIEW", "APPROVED", "LIVE", "SUSPENDED", "TERMINATED", "REJECTED"], notes: "Moved by the onboarding steps" }),
    c("risk_tier", "Risk tier", "string", false),
    c("step_application", "Step: application", "boolean", true),
    c("step_kyb_docs", "Step: KYB documents", "boolean", true),
    c("step_screening", "Step: screening", "boolean", true),
    c("step_bank_verify", "Step: bank verification", "boolean", true),
    c("step_config", "Step: configuration", "boolean", true),
    c("step_approval", "Step: approval", "boolean", true),
    ts("approved_at", "Approved at", false),
    c("approved_by", "Approved by", "string", false),
    ts("created_at", "Created at"),
    ts("updated_at", "Updated at"),
    c("webhook_url", "Callback URL", "url", false),
    c("return_url", "Return URL", "url", false),
    c("webhook_slug", "Webhook slug", "string", false),
    c("gstin", "GSTIN", "string", false),
    c("business_pan", "Business PAN", "string", false, { sensitive: true }),
    c("director_name", "Director name", "string", false),
    c("director_pan", "Director PAN", "string", false, { sensitive: true }),
    c("director_aadhaar_last4", "Director Aadhaar (last 4)", "string", false, { sensitive: true }),
    c("est_monthly_volume", "Estimated monthly volume", "number", false),
    c("webhook_version", "Webhook version", "enum", true, { options: ["v1", "v2"] }),
    c("webhook_events", "Webhook events", "enum", true, { options: ["ALL", "PAID_ONLY"] }),
    c("webhook_secret", "Webhook signing secret", "string", false, { sensitive: true, notes: "Sealed (lib/sealed-text)" }),
    c("webhook_version_set_by", "Webhook version set by", "string", false),
    ts("webhook_version_set_at", "Webhook version set at", false),
    c("parent_tsp_id", "TSP", "uuid", false, { notes: "tsps.id (merchant 0018)" }),
    c("issuing_bank_id", "Issuing bank", "uuid", false, { notes: "banks.id (merchant 0018)" }),
    c("step_mid_issuance", "Step: MID issuance", "boolean", true),
  ],
  MERCHANT: [
    c("id", "ID", "uuid", true, { notes: "Primary key" }),
    c("tenant_id", "Tenant", "string", true, { notes: "Default tenant-default" }),
    c("code", "Merchant code", "string", true, { notes: "Unique (lib/merchant-code)" }),
    c("legal_name", "Legal name", "string", true),
    c("contact_email", "Contact email", "email", true),
    c("contact_phone", "Contact phone", "string", false),
    c("kind", "Kind", "string", true, { notes: "Default PROVIDER" }),
    c("kyc_status", "KYC status", "string", true, { notes: "Default PENDING; changed through Maker-Checker" }),
    c("status", "Status", "string", true, { notes: "Default ACTIVE; changed through Maker-Checker" }),
    c("settlement_currency", "Settlement currency", "string", true, { notes: "Default INR" }),
    c("bank_account_no", "Bank account number", "string", false, { sensitive: true, notes: "Sealed (lib/sealed-text)" }),
    c("bank_ifsc", "Bank IFSC", "string", false),
    c("low_balance_threshold", "Low balance threshold", "number", false),
    ts("created_at", "Created at"),
    ts("updated_at", "Updated at"),
    c("payin_flow", "Pay-in flow", "enum", true, { options: ["UNSET", "P2P", "INTENT", "BOTH"], notes: "lib/payin-flow" }),
    c("payin_active_flow", "Default flow", "enum", false, { options: ["P2P", "INTENT"] }),
    c("payin_flow_set_by", "Flow set by", "string", false),
    ts("payin_flow_set_at", "Flow set at", false),
    c("services", "Services", "enum", true, { options: ["UNSET", "PAYIN", "PAYOUT", "BOTH"], notes: "lib/merchant-services" }),
    c("services_set_by", "Services set by", "string", false),
    ts("services_set_at", "Services set at", false),
  ],
  CHANNEL: [
    c("id", "ID", "uuid", true, { notes: "Primary key" }),
    c("provider", "Provider", "string", true, { notes: "Unique with method + direction" }),
    c("method", "Method", "string", true),
    c("direction", "Direction", "enum", true, { options: ["PAYIN", "PAYOUT"], notes: "Default PAYIN" }),
    c("enabled", "Enabled", "boolean", true, { notes: "Default true" }),
    c("weight", "Weight", "number", true, { notes: "Default 100" }),
    c("mdr_bps", "MDR (bps)", "number", true, { notes: "Default 0" }),
    ts("created_at", "Created at"),
    c("kill_switch", "Kill switch", "boolean", true, { notes: "Default false" }),
    c("kill_switch_reason", "Kill switch reason", "string", false),
    ts("kill_switch_at", "Kill switch at", false),
    c("kill_switch_by", "Kill switch by", "string", false),
  ],
};

export const MASTERS: Record<MasterType, MasterDef> = {
  BANK: {
    type: "BANK", label: "Bank", plural: "Banks", db: "merchant", table: "banks",
    summary: ["code", "name", "bank_type", "status"], search: ["code", "name"], title: "name",
    editHref: () => "/banks", description: "Banks that issue MIDs to bankers through a TSP.",
  },
  TSP: {
    type: "TSP", label: "TSP", plural: "TSPs", db: "merchant", table: "tsps",
    summary: ["code", "name", "tsp_type", "stage"], search: ["code", "name", "legal_name"], title: "name",
    editHref: (id) => `/tsps/${id}`, description: "Technology service providers that carry a bank's MIDs to bankers.",
  },
  BANKER: {
    type: "BANKER", label: "Banker", plural: "Bankers", db: "merchant", table: "merchants",
    summary: ["merchant_code", "legal_name", "contact_email", "stage"], search: ["merchant_code", "legal_name", "brand_name", "contact_email"], title: "legal_name",
    editHref: (id) => `/bankers/${id}`, description: "Bankers (merchants rows) that take pay-ins for a merchant.",
  },
  MERCHANT: {
    type: "MERCHANT", label: "Merchant", plural: "Merchants", db: "provider", table: "providers",
    summary: ["code", "legal_name", "services", "payin_flow", "status"], search: ["code", "legal_name", "contact_email"], title: "legal_name",
    editHref: (id) => `/merchants/${id}`, description: "Merchants (providers rows), each with its bankers.",
  },
  CHANNEL: {
    type: "CHANNEL", label: "Channel", plural: "Channels", db: "routingEngine", table: "rails",
    summary: ["provider", "method", "direction", "enabled"], search: ["provider", "method", "direction"], title: "provider",
    editHref: () => "/channels", description: "Routing rails: one per provider, method and direction.",
  },
};

export function parseMasterType(s: string | null | undefined): MasterType | null {
  const t = (s ?? "").trim().toUpperCase();
  return (MASTER_TYPES as readonly string[]).includes(t) ? (t as MasterType) : null;
}

export const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const MAX_CUSTOM_FIELDS = 50;
const RESERVED_KEYS = new Set(["id", "extra", "created_at", "updated_at"]);
const MAX_VALUE_LEN = 2000;
const MAX_REGEX_LEN = 200;

export const customFields = (fields: MdmField[]) => fields.filter((f) => !f.core);
export const activeCustomFields = (fields: MdmField[]) => customFields(fields).filter((f) => !f.retired);

/** The fields a version is stored with: the code's core fields, then the custom ones. */
export function composeFields(type: MasterType, custom: MdmField[]): MdmField[] {
  return [...CORE[type], ...custom.map((f) => normaliseCustom(f))];
}

/** A custom field as stored: only the properties a custom field may carry. */
export function normaliseCustom(f: MdmField): MdmField {
  const out: MdmField = { key: f.key, label: (f.label ?? "").trim(), type: f.type, required: false };
  if (f.help?.trim()) out.help = f.help.trim();
  if (f.type === "enum") out.options = (f.options ?? []).map((o) => String(o).trim()).filter(Boolean);
  if (f.regex?.trim() && ["string", "email", "url"].includes(f.type)) out.regex = f.regex.trim();
  if (typeof f.min === "number" && Number.isFinite(f.min) && ["string", "email", "url", "number"].includes(f.type)) out.min = f.min;
  if (typeof f.max === "number" && Number.isFinite(f.max) && ["string", "email", "url", "number"].includes(f.type)) out.max = f.max;
  if (f.retired) out.retired = true;
  if (f.requires_approval) out.requires_approval = true;
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) if ((v as any)[k] !== undefined) o[k] = canon((v as any)[k]);
    return o;
  }
  return v;
}

/**
 * The core-lock check: a proposed version must carry every core field of the type exactly as
 * defined in CORE, and nothing else marked core. Null when it does.
 */
export function coreLockProblem(type: MasterType, proposed: MdmField[]): string | null {
  const core = CORE[type];
  const proposedCore = proposed.filter((f) => f.core);
  for (const f of core) {
    const p = proposed.find((x) => x.key === f.key);
    if (!p) return `core field ${f.key} cannot be removed`;
    if (!p.core) return `core field ${f.key} cannot be turned into a custom field`;
    if (!same(p, f)) return `core field ${f.key} is locked and cannot be changed`;
  }
  const extraCore = proposedCore.find((f) => !core.some((x) => x.key === f.key));
  if (extraCore) return `${extraCore.key} is not a column of this table; a new field must be a custom field`;
  return null;
}

/** Problems with one custom field's definition, or null. */
export function customFieldProblem(f: MdmField): string | null {
  if (!f || typeof f !== "object") return "a field must be an object";
  if (typeof f.key !== "string" || !KEY_RE.test(f.key)) return `field key "${f?.key}" must be snake_case: a lower-case letter, then letters, digits or _ (2-40 characters)`;
  if (RESERVED_KEYS.has(f.key)) return `${f.key} is a reserved name`;
  if (typeof f.label !== "string" || !f.label.trim()) return `${f.key}: a label is required`;
  if (f.label.trim().length > 80) return `${f.key}: the label is longer than 80 characters`;
  if (!(CUSTOM_FIELD_TYPES as readonly string[]).includes(f.type)) return `${f.key}: type must be one of ${CUSTOM_FIELD_TYPES.join(", ")}`;
  if (f.required) return `${f.key}: a custom field is optional; existing records have no value for it`;
  if (f.type === "enum") {
    const opts = (f.options ?? []).map((o) => String(o).trim()).filter(Boolean);
    if (!opts.length) return `${f.key}: a choice field needs at least one option`;
    if (new Set(opts).size !== opts.length) return `${f.key}: options must be different from each other`;
    if (opts.some((o) => o.length > 80)) return `${f.key}: an option is longer than 80 characters`;
  }
  if (f.regex) {
    if (f.regex.length > MAX_REGEX_LEN) return `${f.key}: the pattern is longer than ${MAX_REGEX_LEN} characters`;
    try { new RegExp(f.regex); } catch { return `${f.key}: the pattern is not a valid regular expression`; }
  }
  for (const b of ["min", "max"] as const) {
    if (f[b] !== undefined && f[b] !== null && (typeof f[b] !== "number" || !Number.isFinite(f[b]))) return `${f.key}: ${b} must be a number`;
  }
  if (typeof f.min === "number" && typeof f.max === "number" && f.min > f.max) return `${f.key}: min is greater than max`;
  if (f.type !== "number" && ((typeof f.min === "number" && f.min < 0) || (typeof f.max === "number" && f.max < 0)))
    return `${f.key}: a length bound cannot be negative`;
  if (f.help && f.help.length > 300) return `${f.key}: help text is longer than 300 characters`;
  return null;
}

/**
 * Validate a proposed template version (the full field list) against the current one.
 * Checks: core lock, custom keys snake_case and unique, no clash with a core column, enum
 * options, bounds; a custom field that was in the current version is kept (retire it instead
 * of removing it) and keeps its type (its stored values were checked against it).
 */
export function templateProblem(type: MasterType, proposed: MdmField[], current: MdmField[] = CORE[type]): string | null {
  if (!Array.isArray(proposed)) return "fields must be a list";
  const lock = coreLockProblem(type, proposed);
  if (lock) return lock;
  const coreKeys = new Set(CORE[type].map((f) => f.key));
  const custom = customFields(proposed);
  if (custom.length > MAX_CUSTOM_FIELDS) return `at most ${MAX_CUSTOM_FIELDS} custom fields`;
  const seen = new Set<string>();
  for (const f of custom) {
    const p = customFieldProblem(f);
    if (p) return p;
    if (coreKeys.has(f.key)) return `${f.key} is already a core column of this table`;
    if (seen.has(f.key)) return `${f.key} appears twice`;
    seen.add(f.key);
  }
  for (const old of customFields(current)) {
    const now = custom.find((f) => f.key === old.key);
    if (!now) return `${old.key} cannot be removed; retire it instead (its values are kept)`;
    if (now.type !== old.type) return `${old.key}: the type cannot change once records may hold values; retire it and add a new field`;
  }
  return null;
}

/** What changed between two versions' custom fields, in words, for the approval summary. */
export function describeChange(current: MdmField[], proposed: MdmField[]): string[] {
  const out: string[] = [];
  const cur = customFields(current), next = customFields(proposed);
  for (const f of next) {
    const o = cur.find((x) => x.key === f.key);
    if (!o) out.push(`add ${f.key} (${f.type})`);
    else if (f.retired && !o.retired) out.push(`retire ${f.key}`);
    else if (!f.retired && o.retired) out.push(`restore ${f.key}`);
    else if (!same(normaliseCustom(o), normaliseCustom(f))) out.push(`edit ${f.key}`);
  }
  return out;
}

// ── Values ──────────────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** One value against its field, or the problem. `value` is never blank here. */
export function valueProblem(f: MdmField, value: unknown): string | null {
  switch (f.type) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (typeof f.min === "number" && value < f.min) return `must be at least ${f.min}`;
      if (typeof f.max === "number" && value > f.max) return `must be at most ${f.max}`;
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "date": {
      if (typeof value !== "string" || !DATE_RE.test(value)) return "must be a date (YYYY-MM-DD)";
      const d = new Date(value + "T00:00:00Z");
      return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? "is not a real date" : null;
    }
    case "enum":
      return typeof value === "string" && (f.options ?? []).includes(value) ? null : `must be one of ${(f.options ?? []).join(", ")}`;
    case "string": case "email": case "url": {
      if (typeof value !== "string") return "must be text";
      const v = value;
      if (v.length > MAX_VALUE_LEN) return `is longer than ${MAX_VALUE_LEN} characters`;
      if (f.type === "email" && !EMAIL_RE.test(v)) return "must be an email address";
      if (f.type === "url") {
        try { const u = new URL(v); if (u.protocol !== "https:" && u.protocol !== "http:") return "must be an http(s) URL"; }
        catch { return "must be a URL"; }
      }
      if (typeof f.min === "number" && v.length < f.min) return `must be at least ${f.min} characters`;
      if (typeof f.max === "number" && v.length > f.max) return `must be at most ${f.max} characters`;
      if (f.regex) {
        let re: RegExp;
        try { re = new RegExp(`^(?:${f.regex})$`); } catch { return "cannot be checked: the field's pattern is invalid"; }
        if (!re.test(v)) return "does not match the required format";
      }
      return null;
    }
    default:
      return "cannot be set here";
  }
}

export interface ExtraChange { key: string; before: unknown; after: unknown }
export interface ExtraValidation {
  ok: boolean;
  errors: Record<string, string>;
  /** The record's extra after the patch (blank = key removed). */
  next: Record<string, unknown>;
  changes: ExtraChange[];
}

/** A string value as stored: trimmed. Other types as given. */
const clean = (v: unknown) => (typeof v === "string" ? v.trim() : v);

/**
 * Validate a patch of extra values against a template's custom fields.
 *   - unknown keys (not a custom field) are refused;
 *   - a retired field is read-only: a patch that would change its value is refused;
 *   - a blank value (null, "") removes the key;
 *   - a value unchanged from `current` is not a change.
 */
export function validateExtra(fields: MdmField[], current: Record<string, unknown>, patch: Record<string, unknown>): ExtraValidation {
  const errors: Record<string, string> = {};
  const next: Record<string, unknown> = { ...(current ?? {}) };
  const changes: ExtraChange[] = [];
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, errors: { _: "values must be an object" }, next, changes };
  const custom = customFields(fields);
  for (const [key, raw] of Object.entries(patch)) {
    const f = custom.find((x) => x.key === key);
    if (!f) { errors[key] = CORE_KEYS_OF(fields).has(key) ? "is a core field; edit it on its own page" : "is not a field of this template"; continue; }
    const value = clean(raw);
    const before = current?.[key];
    const blank = isBlank(value);
    const unchanged = blank ? before === undefined : same(before, value);
    if (unchanged) continue;
    if (f.retired) { errors[key] = "is retired and read-only"; continue; }
    if (!blank) {
      const p = valueProblem(f, value);
      if (p) { errors[key] = p; continue; }
    }
    if (blank) delete next[key]; else next[key] = value;
    changes.push({ key, before: before ?? null, after: blank ? null : value });
  }
  return { ok: Object.keys(errors).length === 0, errors, next, changes };
}

const CORE_KEYS_OF = (fields: MdmField[]) => new Set(fields.filter((f) => f.core).map((f) => f.key));

/** Split changes into those applied at once and those that need a second person. */
export function splitByApproval(fields: MdmField[], changes: ExtraChange[]): { direct: ExtraChange[]; approval: ExtraChange[] } {
  const needs = new Set(customFields(fields).filter((f) => f.requires_approval).map((f) => f.key));
  return { direct: changes.filter((c) => !needs.has(c.key)), approval: changes.filter((c) => needs.has(c.key)) };
}

// ── Form schema (preview renderer and record view) ────────────────────────────────────────

export type InputKind = "text" | "number" | "checkbox" | "date" | "datetime" | "select" | "multiselect" | "email" | "url";

export interface FormField {
  key: string;
  label: string;
  input: InputKind;
  required: boolean;
  readOnly: boolean;
  sensitive?: boolean;
  options?: string[];
  help?: string;
  pattern?: string;
  min?: number;
  max?: number;
  requiresApproval?: boolean;
  value?: unknown;
}
export interface FormSection { id: "core" | "custom" | "retired"; title: string; readOnly: boolean; fields: FormField[] }

const INPUT: Record<FieldType, InputKind> = {
  string: "text", number: "number", boolean: "checkbox", date: "date", enum: "select", email: "email", url: "url",
  uuid: "text", timestamp: "datetime", list: "multiselect",
};

/**
 * The record form a template describes: core fields (read-only here; edited on their own
 * page), custom fields (editable), and retired custom fields (read-only, shown only when the
 * record holds a value or when no values are given, as in the preview).
 */
export function buildFormSchema(fields: MdmField[], values?: { core?: Record<string, unknown>; extra?: Record<string, unknown> }): FormSection[] {
  const toForm = (f: MdmField, readOnly: boolean, value: unknown): FormField => ({
    key: f.key, label: f.label, input: INPUT[f.type] ?? "text", required: f.required, readOnly,
    ...(f.sensitive ? { sensitive: true } : {}),
    ...(f.options ? { options: f.options } : {}),
    ...(f.help || f.notes ? { help: f.help ?? f.notes } : {}),
    ...(f.regex ? { pattern: f.regex } : {}),
    ...(typeof f.min === "number" ? { min: f.min } : {}),
    ...(typeof f.max === "number" ? { max: f.max } : {}),
    ...(f.requires_approval ? { requiresApproval: true } : {}),
    ...(value !== undefined ? { value } : {}),
  });
  const core = fields.filter((f) => f.core);
  const custom = customFields(fields);
  const retired = custom.filter((f) => f.retired && (!values || values.extra?.[f.key] !== undefined));
  const sections: FormSection[] = [
    { id: "core", title: "Core fields", readOnly: true, fields: core.map((f) => toForm(f, true, values?.core?.[f.key])) },
    { id: "custom", title: "Custom fields", readOnly: false, fields: custom.filter((f) => !f.retired).map((f) => toForm(f, false, values?.extra?.[f.key])) },
  ];
  if (retired.length) sections.push({ id: "retired", title: "Retired fields", readOnly: true, fields: retired.map((f) => toForm(f, true, values?.extra?.[f.key])) });
  return sections;
}

/** The list columns: core summary, then up to three custom fields (the chooser may pick others). */
export function defaultColumns(type: MasterType, fields: MdmField[]): string[] {
  return [...MASTERS[type].summary, ...activeCustomFields(fields).slice(0, 3).map((f) => f.key)];
}
