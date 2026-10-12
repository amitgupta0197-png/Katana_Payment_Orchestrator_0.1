// "Take live": what still stands between a banker and live money, in order, for the staff panel
// (components/merchant/take-live.tsx; wizard last screen and banker page). Pure. Every action goes
// through the existing routes and their checks: onboarding steps (POST …/advance, gates and the
// Super Admin override with a note), live mode (POST …/live-activation, SETUP_INCOMPLETE and its
// override), and each payment account's go-live (POST /api/ops/gateway-golive ping → webhook →
// status → live).

export const ONBOARDING_STEPS = [
  { key: "step_application", from: "APPLICATION", label: "Application" },
  { key: "step_kyb_docs", from: "DOCS_PENDING", label: "Documents" },
  { key: "step_screening", from: "SCREENING", label: "Sanctions check" },
  { key: "step_bank_verify", from: "BANK_VERIFY", label: "Bank account check" },
  { key: "step_mid_issuance", from: "MID_ISSUANCE", label: "Bank-issued IDs" },
  { key: "step_config", from: "CONFIG", label: "Settings" },
  { key: "step_approval", from: "CONFIG", label: "Approval" },
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]["key"];

export interface BankerStage {
  stage: string;
  step_config?: boolean | null;
}

/** The next onboarding step for this banker, or null when it is LIVE (or closed). */
export function nextOnboardingStep(m: BankerStage): (typeof ONBOARDING_STEPS)[number] | null {
  if (m.stage === "CONFIG") return ONBOARDING_STEPS.find((s) => s.key === (m.step_config ? "step_approval" : "step_config"))!;
  return ONBOARDING_STEPS.find((s) => s.from === m.stage) ?? null;
}

/** Steps still to do, in order, from where the banker is. */
export function remainingSteps(m: BankerStage): (typeof ONBOARDING_STEPS)[number][] {
  if (m.stage === "LIVE" || !ONBOARDING_STEPS.some((s) => s.from === m.stage)) return [];
  const i = ONBOARDING_STEPS.findIndex((s) => s.from === m.stage);
  const left = ONBOARDING_STEPS.slice(i);
  return m.stage === "CONFIG" && m.step_config ? left.filter((s) => s.key !== "step_config") : left;
}

export interface GoLiveAccount {
  gateway: string; account: string; account_label?: string; status: string; can_go_live?: boolean;
  /** Where the account's money lands: P2P (a P2P processor account) or INTENT (null = INTENT). */
  channel?: string | null;
  checklist?: { key: string; label: string; done: boolean }[];
}

export type LiveItemKey = "ONBOARDING" | "LIVE_MODE" | "SETUP" | "ACCOUNT" | "TEST";
export interface LiveItem { key: LiveItemKey; label: string; done: boolean; detail: string }

/** The whole picture: onboarding, live mode, accounts still verifying, and a real payment. */
export function takeLiveItems(m: BankerStage, liveStatus: string, accounts: GoLiveAccount[], paidLive: boolean): LiveItem[] {
  const steps = remainingSteps(m);
  const verifying = accounts.filter((a) => a.status === "VERIFYING");
  return [
    { key: "ONBOARDING", label: "Onboarding approved", done: m.stage === "LIVE",
      detail: m.stage === "LIVE" ? "Approved." : `${steps.length} step${steps.length === 1 ? "" : "s"} left: ${steps.map((s) => s.label).join(", ")}.` },
    { key: "LIVE_MODE", label: "Live mode on", done: liveStatus === "ACTIVATED",
      detail: liveStatus === "ACTIVATED" ? "Live payments allowed." : liveStatus === "REQUESTED" ? "Requested by the banker, waiting for approval." : "Not switched on." },
    { key: "ACCOUNT", label: "Payment account live", done: verifying.length === 0,
      detail: verifying.length === 0 ? (accounts.length ? "Every payment account is live." : "No payment account on the go-live checklist.")
        : `${verifying.map((a) => `${a.gateway}${a.account_label && a.account !== "gateway_mid" ? ` (${a.account_label})` : ""}`).join(", ")} still verifying: one real payment, then set live.` },
    { key: "TEST", label: "A real payment went through", done: paidLive,
      detail: paidLive ? "A live payment was paid." : "Make a small live test payment below." },
  ];
}

export type LiveFlow = "P2P" | "INTENT";

/** Steps every banker needs whatever its flow: onboarding approved and live mode on. */
export function commonLiveItems(m: BankerStage, liveStatus: string): LiveItem[] {
  return takeLiveItems(m, liveStatus, [], false).slice(0, 2);
}

/** The flows a banker's setting uses (BOTH and not chosen yet: both). */
export function flowsInUse(flow: string | null | undefined): LiveFlow[] {
  return flow === "P2P" ? ["P2P"] : flow === "INTENT" ? ["INTENT"] : ["P2P", "INTENT"];
}

export const accountFlow = (a: GoLiveAccount): LiveFlow => (a.channel === "P2P" ? "P2P" : "INTENT");

const P2P_SETUP: Record<string, { need: string; done: string }> = {
  UPI_ID: { need: "No settlement UPI ID yet: add it on the Pays UPI ID tab.", done: "Paid on its own UPI ID; the UPI ID is set." },
  BHARATPE: { need: "No active BharatPe MID for the settlement UPI ID: set it up on the Pays UPI ID tab.", done: "Paid on its BharatPe QR; the MID is active." },
  PAYATOM: { need: "No PayAtom P2P account connected: set it up on the Pays UPI ID tab.", done: "Paid through PayAtom; the P2P account is connected." },
};

/**
 * One flow's own checklist, nothing from the other flow: how it is paid, its accounts still
 * verifying (P2P only lists P2P processor accounts, and only when it has one — a UPI ID or
 * BharatPe banker has nothing to verify), and a real payment on that flow.
 */
export function flowLiveItems(flow: LiveFlow, f: {
  ready: boolean; p2pMethod?: string | null; accounts: GoLiveAccount[]; paidLive: boolean;
}): LiveItem[] {
  const accounts = f.accounts.filter((a) => accountFlow(a) === flow);
  const verifying = accounts.filter((a) => a.status === "VERIFYING");
  const words = flow === "P2P"
    ? P2P_SETUP[f.p2pMethod ?? ""] ?? { need: "No P2P method chosen and no settlement UPI ID: choose one on the Pays UPI ID tab.", done: "A settlement UPI ID or P2P processor account is set." }
    : { need: "No payment gateway connected for Intent: connect one on the Pays via gateway tab.", done: "A payment gateway is connected." };
  const items: LiveItem[] = [
    { key: "SETUP", label: flow === "P2P" ? "UPI ID set up" : "Payment gateway connected", done: f.ready, detail: f.ready ? words.done : words.need },
  ];
  if (flow === "INTENT" || accounts.length) {
    items.push({ key: "ACCOUNT", label: "Payment account live", done: verifying.length === 0,
      detail: verifying.length === 0 ? (accounts.length ? "Every payment account is live." : "No payment account on the go-live checklist.")
        : `${verifying.map((a) => `${a.gateway}${a.account_label && a.account !== "gateway_mid" ? ` (${a.account_label})` : ""}`).join(", ")} still verifying: one real payment, then set live.` });
  }
  items.push({ key: "TEST", label: `A real ${flow === "P2P" ? "P2P" : "Intent"} payment went through`, done: f.paidLive,
    detail: f.paidLive ? "A live payment was paid." : `Make a small live ${flow === "P2P" ? "P2P" : "Intent"} test payment below.` });
  return items;
}

/** Words for a gate the onboarding step was refused on ({ gate, result, summary }). */
export function gateWords(g: { gate: string; result: string; summary?: string }): string {
  const name = g.gate.charAt(0) + g.gate.slice(1).toLowerCase().replace(/_/g, " ");
  return `${name}: ${g.result === "FAIL" ? "failed" : "needs review"}${g.summary ? ` — ${g.summary}` : ""}`;
}
