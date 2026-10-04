import { ListChecks, ArrowRightLeft,
  LayoutDashboard,
  BookOpen,
  GitMerge,
  Banknote,
  Send,
  Inbox,
  Users,
  Percent,
  ShieldAlert,
  FileCheck2,
  BarChart3,
  CreditCard,
  Network,
  Workflow,
  Globe,
  Coins,
  Droplets,
  UserCog,
  KeyRound,
  Shield,
  Store,
  UserPlus,
  Receipt,
  Wallet,
  Banknote as Cash,
  Activity,
  Sliders,
  ScrollText,
  Headphones,
  Bot,
  Rocket,
  FileSearch,
  Briefcase,
  FileSpreadsheet,
  QrCode,
  ArrowLeftRight,
  Smartphone,
  Building2,
  Landmark,
  Search,
  Map as MapIcon,
  LayoutTemplate,
  GitBranch,
  HeartPulse,
  Database,
  Layers,
  Plug,
  Table2,
  Server,
  Fingerprint,
  PiggyBank,
  type LucideIcon,
} from "lucide-react";
import { ALL_FEATURES_ON, type FeatureName, type Features } from "./features";

export type NavPersona =
  | "SUPER_ADMIN" | "ADMIN" | "PROVIDER" | "MERCHANT"
  | "OPERATOR" | "COMPLIANCE" | "FINANCE" | "RISK" | "SUPPORT";

export const navGroups = [
  "Overview", "Provider Management", "Payment Management", "Onboarding Journeys", "Payment Flows",
  "Money Movement", "DT Business", "Risk & Compliance", "Operations", "Master Data", "Admin",
] as const;
export type NavGroup = (typeof navGroups)[number];

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  status: "live" | "read-only" | "scaffold";
  group: NavGroup;
  /** Personas that should see this nav entry. Defaults to SUPER_ADMIN only. */
  personas?: NavPersona[];
  /** uam_modules.module_code (Access Matrix). A persona with matrix rows and no read on it does not see the entry. */
  module?: string;
  /** A tabbed hub page (/hub/*). Shown in the sidebar (unless NAV_HUBS is off) when any of its tabs is visible. */
  hub?: boolean;
  /** Set on an item that lives as a tab inside a hub: the hub's href. Still in ⌘K and personaNav. */
  parent?: string;
  /** True when `parent` is set. */
  hubbed?: boolean;
}

/** One tab of a hub: the existing page it re-houses. */
export interface HubTab { key: string; label: string; href: string }
export interface NavHub { href: string; label: string; icon: LucideIcon; group: NavGroup; tabs: HubTab[] }

/** The sidebar section a feature flag hides (lib/features). NAV_HUBS is handled by sidebarNav. */
export const GROUP_FEATURE: Partial<Record<NavGroup, FeatureName>> = {
  "Provider Management": "PROVIDER_MANAGEMENT",
  "Onboarding Journeys": "ONBOARDING_JOURNEYS",
  "Payment Flows": "PAYMENT_FLOWS",
  "Master Data": "MASTER_DATA",
};

// Persona buckets — used by Sidebar to filter the full list before render so
// PROVIDER/MERCHANT never see admin-only links pointing at endpoints they
// can't reach. SUPER_ADMIN always sees everything; the other two see a
// curated subset that matches their own portal entries.
export const SHARED_PERSONAS: NavPersona[] = ["SUPER_ADMIN", "PROVIDER", "MERCHANT"];
export const PROVIDER_NAV: NavPersona[] = ["SUPER_ADMIN", "PROVIDER"];
export const MERCHANT_NAV: NavPersona[] = ["SUPER_ADMIN", "MERCHANT"];
// FIFO ops console — visible to super-admins and the operators who work the queue.
export const OPERATOR_NAV: NavPersona[] = ["SUPER_ADMIN", "OPERATOR"];
// The new staff sections. Never PROVIDER or MERCHANT.
const JOURNEY_PERSONAS: NavPersona[] = ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "RISK", "FINANCE"];
const FLOW_PERSONAS: NavPersona[] = [...JOURNEY_PERSONAS, "SUPPORT"];
const MDM_PERSONAS: NavPersona[] = ["SUPER_ADMIN", "ADMIN"];
/** Sections whose entries the curated personas see by their `personas` list rather than by CURATED_NAV. */
const PERSONA_LISTED_GROUPS = new Set<NavGroup>(["Onboarding Journeys", "Payment Flows", "Master Data"]);

export function filterNavForPersona(items: NavItem[], persona: NavPersona): NavItem[] {
  return items.filter((i) => {
    const allowed = i.personas ?? ["SUPER_ADMIN"];
    return allowed.includes(persona);
  });
}

// Curated nav for the back-office / internal personas. These previously fell back
// to the full ~60-item super-admin menu; here each sees only the consoles relevant
// to their job. Nothing is removed from the app — every page stays reachable by URL
// and the ⌘K command palette; this only declutters the sidebar (presentation only).
const CURATED_NAV: Partial<Record<NavPersona, string[]>> = {
  OPERATOR:   ["/", "/orders", "/gateway-health", "/mid-switch", "/operator", "/status-intelligence", "/transaction-intel", "/fifo-dashboard", "/security"],
  FINANCE:    ["/", "/status-intelligence", "/transaction-intel", "/fifo-dashboard", "/payouts", "/fifo-settlements", "/fifo-reconciliation", "/fifo-reports", "/ledger", "/settlement-engine", "/settlement", "/reserves", "/chargebacks", "/dt-dashboard", "/dt-purchases", "/dt-refills", "/security"],
  RISK:       ["/", "/status-intelligence", "/transaction-intel", "/fifo-dashboard", "/forensics", "/cases", "/risk", "/risk/aml", "/risk/payin-flags", "/chargebacks", "/fifo-reports", "/fifo-controls", "/tsps", "/banks", "/security"],
  COMPLIANCE: ["/", "/forensics", "/cases", "/kyb", "/disputes", "/chargebacks", "/risk/aml", "/risk/payin-flags", "/fifo-controls", "/fifo-reports", "/tsps", "/banks", "/security"],
  SUPPORT:    ["/", "/orders", "/api-log", "/support-bot", "/payin-data", "/payout-data", "/summary", "/security"],
};

/** Read right per module_code for one persona (lib/access rightsFor; only can_read is used here). */
export type NavAccess = Record<string, { can_read: boolean }>;

export interface PersonaNavOptions {
  /** The persona's Access Matrix rows. Empty / absent = no rows: the curated behaviour, unchanged. */
  access?: NavAccess | null;
  /** Feature flags (lib/features). Absent = all on. */
  features?: Features;
}

const isPortalPersona = (p: NavPersona) => p === "PROVIDER" || p === "MERCHANT";

// The persona's base list, exactly as before hubs, flags and the matrix (hub entries excluded).
function baseNav(items: NavItem[], persona: NavPersona): NavItem[] {
  const pages = items.filter((i) => !i.hub);
  if (persona === "SUPER_ADMIN" || persona === "ADMIN") return filterNavForPersona(pages, "SUPER_ADMIN");
  if (isPortalPersona(persona)) return filterNavForPersona(pages, persona);
  const allow = CURATED_NAV[persona];
  if (allow) return pages.filter((i) => allow.includes(i.href) || (PERSONA_LISTED_GROUPS.has(i.group) && (i.personas ?? []).includes(persona)));
  return filterNavForPersona(pages, "SUPER_ADMIN");
}

// Resolve the nav a given persona should see. SUPER_ADMIN/ADMIN see everything;
// PROVIDER/MERCHANT use their existing tag-based subset; the internal personas use
// the curated allow-list above (plus the new sections by their persona lists); any
// unknown persona safely falls back to the full list. Then:
//  - a section whose feature flag is off is left out (nav only; its pages stay reachable);
//  - with Access Matrix rows for the persona, an entry mapped to a module the persona
//    cannot read is left out (SUPER_ADMIN always sees all; no rows = unchanged);
//  - a hub entry is included when any of its tabs is, and never for PROVIDER/MERCHANT.
// The result holds hubbed items too (⌘K and hub tabs use it); sidebarNav decides the menu.
export function personaNav(items: NavItem[], persona: NavPersona, opts: PersonaNavOptions = {}): NavItem[] {
  const features = opts.features ?? ALL_FEATURES_ON;
  const flagOn = (i: NavItem) => { const f = GROUP_FEATURE[i.group]; return !f || features[f]; };
  const access = opts.access && Object.keys(opts.access).length > 0 ? opts.access : null;
  const readable = (i: NavItem) => persona === "SUPER_ADMIN" || !access || !i.module || access[i.module]?.can_read === true;

  const pages = baseNav(items, persona).filter((i) => flagOn(i) && readable(i));
  if (isPortalPersona(persona)) return pages;
  const shown = new Set(pages.map((i) => i.href));
  const tabOk = (href: string) => shown.has(href) && middlewareLets(persona, href);
  return items.filter((i) => (i.hub ? flagOn(i) && items.some((c) => c.parent === i.href && tabOk(c.href)) : shown.has(i.href)));
}

// Mirrors SUPER_ADMIN_UI in src/middleware.ts: these pages redirect every other persona home.
// A hub renders its tabs at /hub/*, outside that redirect, so it must leave them out itself.
const SUPER_ADMIN_UI = [
  "/admin", "/tenants", "/routing", "/pg-adapter", "/bank-adapter",
  "/crypto-rail", "/integrations", "/vendors", "/channels", "/fund",
  "/admin-log", "/agents", "/events", "/p2p", "/payin-flows", "/merchant-readiness",
];
function middlewareLets(persona: NavPersona, href: string): boolean {
  if (persona === "SUPER_ADMIN") return true;
  return !SUPER_ADMIN_UI.some((p) => href === p || href.startsWith(p + "/"));
}

/** The tabs of a hub a persona is offered: in its menu (personaNav result) and let through by the middleware. */
export function hubTabs(hub: NavHub, visible: NavItem[], persona: NavPersona): HubTab[] {
  const shown = new Set(visible.map((i) => i.href));
  return hub.tabs.filter((t) => shown.has(t.href) && middlewareLets(persona, t.href));
}

/**
 * The sidebar's entries from a personaNav result. With NAV_HUBS on, a hub stands in for its
 * tabs; with it off, hubs are dropped and their tabs come back as the old flat menu.
 */
export function sidebarNav(visible: NavItem[], features: Features = ALL_FEATURES_ON): NavItem[] {
  if (!features.NAV_HUBS) return visible.filter((i) => !i.hub);
  const hubs = new Set(visible.filter((i) => i.hub).map((i) => i.href));
  return visible.filter((i) => !(i.parent && hubs.has(i.parent)));
}

/** "FIFO › Reports" for a hubbed item, its label otherwise. */
export function navTrail(item: NavItem): string {
  const hub = item.parent ? navHubs.find((h) => h.href === item.parent) : undefined;
  if (!hub) return item.label;
  const tab = hub.tabs.find((t) => t.href === item.href);
  return `${hub.label} › ${tab?.label ?? item.label}`;
}

// Hubs re-house existing pages as tabs (/hub/*). Nothing is removed or renamed: each tab
// renders the existing page, and its own URL keeps working.
export const navHubs: NavHub[] = [
  { href: "/hub/orders", label: "Orders", icon: Receipt, group: "Payment Management", tabs: [
    { key: "payin", label: "Payin Order", href: "/payin-order" },
    { key: "payout", label: "Payout Order", href: "/payout-order" },
    { key: "summary", label: "Summary", href: "/summary" },
  ] },
  { href: "/hub/data", label: "Order data", icon: Table2, group: "Payment Management", tabs: [
    { key: "payin", label: "Payin Data", href: "/payin-data" },
    { key: "payout", label: "Payout Data", href: "/payout-data" },
  ] },
  { href: "/hub/banker-finance", label: "Banker finance", icon: Wallet, group: "Money Movement", tabs: [
    { key: "wallet", label: "Banker Wallet", href: "/merchant-wallet" },
    { key: "fund", label: "Fund", href: "/fund" },
    { key: "settlements", label: "Banker Settlements", href: "/branch-settlements" },
    { key: "collections", label: "Collections", href: "/collections" },
  ] },
  { href: "/hub/adapters", label: "Adapters", icon: Plug, group: "Money Movement", tabs: [
    { key: "pg", label: "PG", href: "/pg-adapter" },
    { key: "bank", label: "Bank", href: "/bank-adapter" },
  ] },
  { href: "/hub/finance", label: "Finance", icon: PiggyBank, group: "Money Movement", tabs: [
    { key: "commission", label: "Commission", href: "/commission" },
    { key: "partner-data", label: "Partner Data", href: "/partner-data" },
    { key: "reserves", label: "Reserves", href: "/reserves" },
  ] },
  { href: "/hub/dt", label: "DT", icon: Coins, group: "DT Business", tabs: [
    { key: "dashboard", label: "Dashboard", href: "/dt-dashboard" },
    { key: "purchases", label: "Purchases", href: "/dt-purchases" },
    { key: "refills", label: "Refills", href: "/dt-refills" },
  ] },
  { href: "/hub/fifo", label: "FIFO", icon: Layers, group: "Operations", tabs: [
    { key: "dashboard", label: "Dashboard", href: "/fifo-dashboard" },
    { key: "reports", label: "Reports", href: "/fifo-reports" },
    { key: "reconciliation", label: "Reconciliation", href: "/fifo-reconciliation" },
    { key: "settlements", label: "Settlements", href: "/fifo-settlements" },
  ] },
  { href: "/hub/reporting", label: "Reporting", icon: BarChart3, group: "Operations", tabs: [
    { key: "statements", label: "Statements", href: "/statements" },
    { key: "reporting", label: "Reporting", href: "/reporting" },
  ] },
  { href: "/hub/identity", label: "Identity & access", icon: Fingerprint, group: "Admin", tabs: [
    { key: "users", label: "Users", href: "/admin/users" },
    { key: "roles", label: "Roles & Permissions", href: "/admin/roles" },
    { key: "access", label: "Access matrix", href: "/admin/access" },
    { key: "assignments", label: "Assignments", href: "/admin/assignments" },
  ] },
  { href: "/hub/security", label: "Security & keys", icon: KeyRound, group: "Admin", tabs: [
    { key: "api-keys", label: "API Keys", href: "/admin/api-keys" },
    { key: "vault", label: "Vault & tokens", href: "/admin/tokens" },
    { key: "mfa", label: "Security (MFA)", href: "/security" },
    { key: "webhooks", label: "Webhooks", href: "/admin/webhooks" },
  ] },
  { href: "/hub/platform-ops", label: "Platform ops", icon: Server, group: "Admin", tabs: [
    { key: "noc", label: "NOC", href: "/admin/noc" },
    { key: "hardening", label: "Hardening", href: "/admin/hardening" },
  ] },
];

const rawNavItems: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, status: "live", group: "Overview", personas: SHARED_PERSONAS },
  { href: "/admin-log", label: "Admin Log", icon: ScrollText, status: "live", group: "Overview", module: "admin_log" },

  // The chain a banker's MIDs come from: Bank → TSP → Banker (lib/chain). Staff only.
  { href: "/tsps",  label: "TSPs / Providers", icon: Building2, status: "live", group: "Provider Management", personas: ["SUPER_ADMIN", "ADMIN", "COMPLIANCE", "RISK", "OPERATOR", "FINANCE"] },
  { href: "/banks", label: "Banks",            icon: Landmark,  status: "live", group: "Provider Management", personas: ["SUPER_ADMIN", "ADMIN", "COMPLIANCE", "RISK", "OPERATOR", "FINANCE"] },

  { href: "/merchants",        label: "Merchants",       icon: UserPlus, status: "live", group: "Payment Management", module: "providers" },
  { href: "/sub-mids",         label: "Sub-MIDs",        icon: Network,  status: "live", group: "Payment Management", module: "sub_mids" },
  { href: "/bankers",        label: "Banker",          icon: Store,    status: "live", group: "Payment Management", module: "merchants" },
  { href: "/merchant-config",  label: "Banker Config",   icon: Sliders,  status: "live", group: "Payment Management" },
  // Pay-in flows: the P2P / Intent / Both bifurcation, and one sub-module per flow.
  { href: "/merchant-readiness", label: "Merchant readiness", icon: ListChecks, status: "live", group: "Payment Management" },
  { href: "/payin-flows",        label: "Pay-in Flows",    icon: ArrowLeftRight, status: "live", group: "Payment Management" },
  { href: "/payin-flows/p2p",    label: "P2P Pay-ins",     icon: Smartphone,     status: "live", group: "Payment Management" },
  { href: "/payin-flows/intent", label: "Intent Pay-ins",  icon: Building2,      status: "live", group: "Payment Management" },
  // The order desk and the v2 operations screens. Open to every staff role, like their APIs.
  { href: "/orders",           label: "Order search",    icon: Search,     status: "live", group: "Payment Management", personas: ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"] },
  { href: "/gateway-health",   label: "Gateway health",  icon: Activity,   status: "live", group: "Payment Management", personas: ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"] },
  { href: "/gateway-golive",   label: "Gateway go-live", icon: Rocket,     status: "live", group: "Payment Management", personas: ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"] },
  { href: "/webhook-settings", label: "Webhook settings", icon: Workflow,  status: "live", group: "Payment Management", personas: ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"] },
  { href: "/api-log",          label: "API request log", icon: ScrollText, status: "live", group: "Payment Management", personas: ["SUPER_ADMIN", "ADMIN", "OPERATOR", "COMPLIANCE", "FINANCE", "RISK", "SUPPORT"] },
  { href: "/qr-switch",        label: "QR Operations",   icon: QrCode,   status: "live", group: "Payment Management", personas: ["SUPER_ADMIN", "ADMIN", "OPERATOR"] },
  { href: "/transactions",     label: "Transactions",    icon: Receipt,  status: "live", group: "Payment Management" },
  // Personas match the /api/statements gate — a link to an endpoint the viewer is refused by
  // is worse than no link.
  { href: "/statements",       label: "Statements",      icon: FileSpreadsheet, status: "live", group: "Payment Management", personas: ["SUPER_ADMIN", "ADMIN", "FINANCE"] },
  { href: "/payin-order",      label: "Payin Order",     icon: Receipt,  status: "live", group: "Payment Management" },
  { href: "/summary",          label: "Summary",         icon: BarChart3,status: "live", group: "Payment Management" },
  { href: "/payout-order",     label: "Payout Order",    icon: Send,     status: "live", group: "Payment Management" },
  { href: "/merchant-wallet",  label: "Banker Wallet",   icon: Wallet,   status: "live", group: "Payment Management" },
  { href: "/fund",             label: "Fund",            icon: Cash,     status: "live", group: "Payment Management", module: "fund" },
  { href: "/payin-data",       label: "Payin Data",      icon: Activity, status: "live", group: "Payment Management" },
  { href: "/payout-data",      label: "Payout Data",     icon: Activity, status: "live", group: "Payment Management" },
  { href: "/channels",         label: "Channels",        icon: Network,  status: "live", group: "Payment Management", module: "channels" },

  // Onboarding journeys (being built): the tracker, its templates and the Bank → TSP → Banker chain.
  { href: "/journeys",           label: "Journey Tracker",    icon: MapIcon,        status: "live", group: "Onboarding Journeys", personas: JOURNEY_PERSONAS },
  { href: "/workflow-templates", label: "Workflow Templates", icon: LayoutTemplate, status: "live", group: "Onboarding Journeys", personas: JOURNEY_PERSONAS },
  { href: "/chain",              label: "Chain visualiser",   icon: GitBranch,      status: "live", group: "Onboarding Journeys", personas: JOURNEY_PERSONAS },

  // Payment flows (being built): one console per flow, and their health.
  { href: "/flows/intent", label: "Intent Payin",        icon: Building2,  status: "live", group: "Payment Flows", personas: FLOW_PERSONAS },
  { href: "/flows/p2p",    label: "P2P Payin",           icon: Smartphone, status: "live", group: "Payment Flows", personas: FLOW_PERSONAS },
  { href: "/flows/payout", label: "Payout",              icon: Send,       status: "live", group: "Payment Flows", personas: FLOW_PERSONAS },
  { href: "/flows/health", label: "Flow Health Monitor", icon: HeartPulse, status: "live", group: "Payment Flows", personas: FLOW_PERSONAS },

  { href: "/ledger", label: "Ledger", icon: BookOpen, status: "live", group: "Money Movement", module: "ledger" },
  { href: "/payout", label: "Payouts (gRPC)", icon: Send, status: "live", group: "Money Movement", module: "payout" },
  { href: "/settlement", label: "Settlements", icon: Banknote, status: "live", group: "Money Movement", module: "settlement" },
  { href: "/branch-settlements", label: "Banker Settlements", icon: Banknote, status: "live", group: "Money Movement" },
  { href: "/settlement-engine", label: "Settlement Engine", icon: Banknote, status: "live", group: "Money Movement", personas: ["SUPER_ADMIN", "ADMIN", "OPERATOR", "FINANCE", "COMPLIANCE"] },
  { href: "/collections", label: "Collections", icon: Inbox, status: "live", group: "Money Movement" },
  { href: "/checkout", label: "Checkout", icon: CreditCard, status: "live", group: "Money Movement", module: "checkout" },
  { href: "/routing", label: "Routing Engine", icon: Workflow, status: "live", group: "Money Movement", module: "routing" },
  { href: "/pg-adapter", label: "PG Adapters", icon: Network, status: "live", group: "Money Movement" },
  { href: "/bank-adapter", label: "Bank Adapters", icon: Network, status: "live", group: "Money Movement" },
  { href: "/crypto-rail", label: "Crypto Rails", icon: Coins, status: "live", group: "Money Movement" },
  { href: "/vendors/katana", label: "Katana Pay", icon: CreditCard, status: "live", group: "Money Movement" },
  // Each banker's pay-in traffic between its own MIDs (lib/mid-switch).
  { href: "/mid-switch", label: "MID switch", icon: ArrowRightLeft, status: "live", group: "Money Movement" },
  // Display name only — the rail code stays QUICKPAY in the DB, adapters and routes.
  { href: "/vendors/quickpay", label: "Vendor PG", icon: CreditCard, status: "live", group: "Money Movement" },

  { href: "/partner-data", label: "Partner Data", icon: GitMerge, status: "live", group: "Money Movement", module: "partner_data" },
  { href: "/reserves", label: "Reserves", icon: BookOpen, status: "live", group: "Money Movement", module: "reserves" },

  { href: "/dt-dashboard", label: "DT Dashboard", icon: Coins, status: "live", group: "DT Business", personas: ["SUPER_ADMIN", "ADMIN", "FINANCE"] },
  { href: "/dt-purchases", label: "DT Purchases", icon: Receipt, status: "live", group: "DT Business", personas: ["SUPER_ADMIN", "ADMIN", "FINANCE"] },
  { href: "/dt-refills", label: "DT Refills", icon: Droplets, status: "live", group: "DT Business", personas: ["SUPER_ADMIN", "ADMIN", "FINANCE"] },

  { href: "/reconciliation", label: "Reconciliation", icon: GitMerge, status: "live", group: "Risk & Compliance", module: "reconciliation" },
  { href: "/risk", label: "Risk & Velocity", icon: ShieldAlert, status: "live", group: "Risk & Compliance", module: "risk" },
  { href: "/risk/aml", label: "AML / Sanctions", icon: ShieldAlert, status: "live", group: "Risk & Compliance", module: "risk" },
  { href: "/risk/payin-flags", label: "Pay-in flags", icon: ShieldAlert, status: "live", group: "Risk & Compliance" },
  { href: "/disputes", label: "Disputes", icon: ShieldAlert, status: "live", group: "Risk & Compliance", module: "disputes" },
  // Banker-side chargebacks on Katana Pay pay-ins (lib/chargebacks-store); rules on its Rules tab.
  { href: "/chargebacks", label: "Chargebacks", icon: ShieldAlert, status: "live", group: "Risk & Compliance" },
  { href: "/kyb", label: "KYB", icon: FileCheck2, status: "live", group: "Risk & Compliance", module: "kyb" },
  { href: "/forensics", label: "Forensics", icon: FileSearch, status: "live", group: "Risk & Compliance" },
  { href: "/cases", label: "Compliance Cases", icon: Briefcase, status: "live", group: "Risk & Compliance", module: "aml_cases" },

  { href: "/operator", label: "Operator Console", icon: Headphones, status: "live", group: "Operations", personas: OPERATOR_NAV },
  // Staff test it here; merchants and bankers use it from their portals once SUPPORT_BOT_PORTALS is on (lib/support-bot).
  { href: "/support-bot", label: "Support assistant", icon: Bot, status: "live", group: "Operations", personas: ["SUPER_ADMIN", "ADMIN", "SUPPORT"] },
  { href: "/payouts", label: "Payouts & Beneficiaries", icon: Send, status: "live", group: "Operations" },
  { href: "/status-intelligence", label: "Status Intelligence", icon: Activity, status: "live", group: "Operations" },
  { href: "/transaction-intel", label: "Transaction Intel", icon: ShieldAlert, status: "live", group: "Operations" },
  { href: "/fifo-dashboard", label: "FIFO Dashboard", icon: LayoutDashboard, status: "live", group: "Operations" },
  { href: "/fifo-reports", label: "FIFO Reports", icon: BarChart3, status: "live", group: "Operations" },
  { href: "/fifo-reconciliation", label: "FIFO Reconciliation", icon: GitMerge, status: "live", group: "Operations" },
  { href: "/fifo-settlements", label: "FIFO Settlements", icon: Banknote, status: "live", group: "Operations" },
  { href: "/agents", label: "Agents & Franchise", icon: Users, status: "live", group: "Operations" },
  { href: "/p2p", label: "P2P Traders", icon: Users, status: "live", group: "Operations" },
  { href: "/commission", label: "Commission", icon: Percent, status: "live", group: "Operations", module: "commission" },
  { href: "/events", label: "Event stream", icon: Activity, status: "live", group: "Operations", module: "events" },
  { href: "/reporting", label: "Reporting", icon: BarChart3, status: "read-only", group: "Operations", module: "reporting" },
  { href: "/tenants", label: "Tenants", icon: Globe, status: "live", group: "Operations", module: "tenants" },

  // Master data (being built). Staff administrators only.
  { href: "/mdm",           label: "MDM Home",         icon: Database,       status: "live", group: "Master Data", personas: MDM_PERSONAS },
  { href: "/mdm/templates", label: "Template Manager", icon: LayoutTemplate, status: "live", group: "Master Data", personas: MDM_PERSONAS },

  { href: "/admin/users",          label: "Users",        icon: UserCog,  status: "live", group: "Admin", module: "users" },
  { href: "/admin/mailboxes",      label: "Mailboxes",    icon: KeyRound, status: "live", group: "Admin" },
  { href: "/admin/roles",          label: "Roles & Permissions", icon: Shield, status: "live", group: "Admin", module: "roles" },
  { href: "/admin/api-keys",       label: "API Keys",     icon: KeyRound, status: "live", group: "Admin", module: "api_keys" },
  { href: "/admin/assignments",    label: "Assignments",  icon: UserPlus, status: "live", group: "Admin", module: "assignments" },
  { href: "/admin/access",         label: "Access matrix", icon: Shield,   status: "live", group: "Admin", module: "access" },
  { href: "/admin/maker-checker",  label: "Maker-Checker", icon: ShieldAlert, status: "live", group: "Admin", module: "maker_checker" },
  { href: "/admin/webhooks",       label: "Webhooks", icon: Workflow, status: "live", group: "Admin", module: "webhooks" },
  { href: "/admin/routing",        label: "Routing cockpit", icon: GitMerge, status: "live", group: "Admin" },
  { href: "/admin/tokens",         label: "Vault & tokens", icon: KeyRound, status: "live", group: "Admin", module: "tokens" },
  { href: "/admin/noc",            label: "NOC cockpit", icon: Activity, status: "live", group: "Admin", module: "noc" },
  { href: "/admin/refunds",        label: "Refunds", icon: Banknote, status: "live", group: "Admin", module: "refunds" },
  { href: "/admin/ai-ops",         label: "AI Ops", icon: Users, status: "live", group: "Admin", module: "agents" },
  { href: "/admin/hardening",      label: "Hardening", icon: Shield, status: "live", group: "Admin", module: "hardening" },
  { href: "/integrations",         label: "Integrations", icon: KeyRound, status: "live", group: "Admin", module: "credentials" },
  { href: "/partner-inquiries",     label: "Partner Inquiries", icon: Headphones, status: "live", group: "Admin", personas: ["SUPER_ADMIN", "ADMIN", "SUPPORT"] },
  { href: "/live-activations",     label: "Live activations", icon: Rocket, status: "live", group: "Admin", personas: ["SUPER_ADMIN"] },
  { href: "/security",             label: "Security (MFA)", icon: Shield, status: "live", group: "Admin", personas: ["SUPER_ADMIN", "PROVIDER", "MERCHANT", "OPERATOR"] },
  { href: "/fifo-controls",        label: "Banker Controls", icon: Sliders, status: "live", group: "Admin" },
];

// The full list: each hubbed item carries its hub, and each hub entry sits where its first
// tab in the hub's own section used to be, so the flat order (NAV_HUBS off) is exactly the old one.
export const navItems: NavItem[] = (() => {
  const hubOf = new Map<string, NavHub>();
  for (const h of navHubs) for (const t of h.tabs) hubOf.set(t.href, h);
  const placed = new Set<string>();
  const out: NavItem[] = [];
  for (const i of rawNavItems) {
    const h = hubOf.get(i.href);
    if (h && i.group === h.group && !placed.has(h.href)) {
      placed.add(h.href);
      out.push({ href: h.href, label: h.label, icon: h.icon, status: "live", group: h.group, hub: true });
    }
    out.push(h ? { ...i, parent: h.href, hubbed: true } : i);
  }
  return out;
})();

export function hubByHref(href: string): NavHub | undefined {
  return navHubs.find((h) => h.href === href);
}
