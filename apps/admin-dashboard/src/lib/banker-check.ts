// "Check this banker": every gate a live order meets on one banker, in the order
// createKatanaOrder meets them (lib/katana-order createKatanaOrderOnce), answered in plain words
// without creating an order or asking a gateway. Pure: the facts are read by
// lib/banker-check-store, which calls the same functions the order path calls.
//
// A blocker is something that refuses a live order today. A note is something to know that does
// not refuse every order (a verifying account's cap, a gateway minimum, a callback that failed).
// Staff only: it names the gateway.

import type { MerchantFlow } from "@/lib/payin-flow";
import { decideOrderFlow } from "@/lib/payin-flow";
import type { MerchantServicesSetting, SetupItem } from "@/lib/merchant-services";
import { allowsPayin } from "@/lib/merchant-services";
import type { CheckoutMode } from "@/lib/pg-catalog";

export interface BankerCheckFacts {
  code: string;
  name: string;
  blocked: boolean;
  /** The banker's onboarding stage is SUSPENDED / TERMINATED / REJECTED (lib/katana-order CLOSED_STAGES). */
  stageClosed: boolean;
  stage: string;
  /** Its merchant (`providers` row) is suspended or terminated. */
  providerClosed: boolean;
  services: MerchantServicesSetting;
  flow: MerchantFlow;
  /** Its merchant is an exclusive partner (lib/partner/exclusive). */
  partnerExclusive: boolean;
  partnerName: string | null;
  liveActivated: boolean;
  activationStatus: string;
  /** lib/merchant-setup bankerSetup items (the go-live SETUP gate). */
  setup: SetupItem[];
  /** The first pay-in account, when one is saved. */
  account: null | {
    gateway: string; gatewayName: string; env: string; connector: boolean;
    channel: "INTENT" | "P2P"; checkout: CheckoutMode | null;
    /** gateway_golive status; null = not on the checklist (live before it existed). */
    golive: "VERIFYING" | "LIVE" | null;
    verifyCap: number;
    minAmount: number | null;
  };
  /** A settlement UPI ID is saved (katana_pay.settlement_vpa / settlement_vpas). */
  upiId: string | null;
  /** Capture phones: enrolled, and online with permissions now. */
  phones: { enrolled: number; online: number; lastHeartbeat: string | null };
  /** Effective limits in rupees (lib/payin-limits effectivePayinLimits). */
  limits: { min: number | null; max: number | null; daily: number | null; upiMax: number | null };
  liveKey: boolean;
  callback: { url: string | null; lastOk: boolean | null; lastAt: string | null; lastHttp: number | null };
}

export interface CheckFix { label: string; tab?: string; href?: string }
export interface CheckItem { key: string; title: string; detail: string; fix?: CheckFix }
export interface BankerCheckResult {
  ready: boolean;
  /** One sentence for the top of the result. */
  headline: string;
  blockers: CheckItem[];
  notes: CheckItem[];
  passed: CheckItem[];
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const ago = (iso: string | null, now: Date): string => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
};

/** The flow a live order with no flow named takes (the general order API), or null with none chosen. */
export function defaultOrderFlow(flow: MerchantFlow): "P2P" | "INTENT" | null {
  const d = decideOrderFlow(flow, null);
  return d.ok ? d.flow : null;
}

export function checkBanker(f: BankerCheckFacts, now: Date = new Date()): BankerCheckResult {
  const blockers: CheckItem[] = [], notes: CheckItem[] = [], passed: CheckItem[] = [];
  const pass = (key: string, title: string, detail: string) => passed.push({ key, title, detail });

  // 1. Blocked, suspended, closed (the first thing createKatanaOrderOnce reads).
  if (f.blocked) blockers.push({ key: "BLOCKED", title: "This banker is blocked", detail: "It takes no new orders until it is unblocked.", fix: { label: "Open payment settings", tab: "overview" } });
  else if (f.stageClosed) blockers.push({ key: "SUSPENDED", title: `This banker is ${f.stage.toLowerCase()}`, detail: "A suspended, terminated or rejected banker takes no orders." });
  else pass("NOT_BLOCKED", "Not blocked", "Active");

  // 2. Live mode.
  if (f.liveActivated) pass("LIVE_MODE", "Live payments approved", "Live mode is on");
  else blockers.push({ key: "LIVE_MODE", title: "Live payments aren't switched on", detail: f.activationStatus === "REQUESTED" ? "The request is waiting for a Super Admin." : "Only test orders work until live mode is approved.", fix: { label: "Open live mode", tab: "developer" } });

  // 3. Its merchant: closed, pay-ins off, exclusive partner.
  if (f.providerClosed) blockers.push({ key: "MERCHANT_SUSPENDED", title: "Its merchant is suspended", detail: "Every banker of a suspended merchant refuses orders." });
  if (!allowsPayin(f.services)) blockers.push({ key: "PAYIN_NOT_ENABLED", title: "Its merchant is set up for payouts only", detail: "Pay-in orders are refused. Change the merchant's services if it should take payments.", fix: { label: "Open merchant readiness", href: "/merchant-readiness" } });
  else pass("PAYIN_ENABLED", "Takes pay-ins", f.services === "UNSET" ? "Nothing chosen for its merchant: pay-ins allowed as before" : "Its merchant is set up for payments in");
  if (f.partnerExclusive) blockers.push({ key: "PARTNER_ONLY", title: "Its merchant only allows partner orders", detail: `${f.partnerName ?? "Its merchant"} is an exclusive partner. Orders signed with this banker's own key are refused.`, fix: { label: "Open partner settings", href: "/partners" } });

  // 4. How customers pay, and what that needs.
  const flow = defaultOrderFlow(f.flow);
  const missing = f.setup.filter((i) => i.state === "MISSING");
  if (f.flow.flow === "UNSET") notes.push({ key: "FLOW_UNSET", title: "No payment flow chosen", detail: "Orders are routed the old way: a connected gateway if there is one, else its UPI ID.", fix: { label: "Choose how customers pay", tab: "overview" } });
  else pass("FLOW", "How customers pay", flow === "P2P" ? "Customer pays the banker's UPI ID (P2P)" : flow === "INTENT" ? "Customer pays through a payment gateway (Intent)" : "Both flows");
  for (const m of missing) {
    if (m.key === "P2P_UPI_ID") blockers.push({ key: "NO_UPI_ID", title: "No UPI ID for payments to land on", detail: "It is on P2P, so a live order needs the UPI ID the customer pays.", fix: { label: "Save the UPI ID", tab: "p2p" } });
    else if (m.key === "INTENT_GATEWAY") blockers.push({ key: "NO_PAYMENT_ACCOUNT", title: "No payment account connected", detail: "It is on Intent, so a live order needs a gateway account to take the payment.", fix: { label: "Connect a payment account", tab: "intent" } });
    else if (m.key === "CHOICE") blockers.push({ key: "NO_FLOW", title: "No payment flow chosen", detail: "Its merchant takes pay-ins but no flow is selected.", fix: { label: "Choose how customers pay", tab: "overview" } });
  }

  // 5. Where the money lands.
  const a = f.account;
  if (a && a.channel === "INTENT" && flow !== "P2P") {
    if (!a.connector) blockers.push({ key: "ACCOUNT_NOT_USABLE", title: `${a.gatewayName} account saved but not usable`, detail: "Katana can't take payments through this gateway yet.", fix: { label: "Open the payment account", tab: "intent" } });
    else if (a.env !== "PROD") blockers.push({ key: "ACCOUNT_SANDBOX", title: `${a.gatewayName} account is a test account`, detail: "Live orders need the gateway's live credentials.", fix: { label: "Open the payment account", tab: "intent" } });
    else pass("ACCOUNT", "Where money lands", `${a.gatewayName} account (${a.checkout === "H2H" ? "host-to-host" : a.checkout === "REDIRECT" ? "redirect" : "live"})`);
    if (a.golive === "VERIFYING") notes.push({ key: "VERIFYING", title: "Payment account is still being verified", detail: `Only payments up to ${rupees(a.verifyCap)} are taken until one real payment is confirmed and it is set live.`, fix: { label: "Open Gateway go-live", href: "/gateway-golive" } });
    if (a.minAmount) notes.push({ key: "GATEWAY_MINIMUM", title: `${a.gatewayName} takes ${rupees(a.minAmount)} or more`, detail: `Smaller orders are refused by the gateway.${a.golive === "VERIFYING" && a.minAmount > a.verifyCap ? " That is above the verification cap, so no order can be paid until the cap allows it." : ""}` });
  }
  if (flow === "P2P" || (flow === null && !(a && a.channel === "INTENT"))) {
    if (f.upiId) pass("UPI_ID", "Where money lands", `UPI ID ${f.upiId.length > 12 ? `${f.upiId.slice(0, 10)}…` : f.upiId}`);
    if (!(a && a.channel === "P2P")) {
      if (f.phones.online > 0) pass("PHONE", "Phone reading payments", `Last heard ${ago(f.phones.lastHeartbeat, now)}`);
      else notes.push({ key: "PHONE_OFFLINE", title: f.phones.enrolled ? "No capture phone online" : "No capture phone installed", detail: f.phones.enrolled ? `Last heard ${ago(f.phones.lastHeartbeat, now)}. P2P payments won't be confirmed until one is back.` : "Without a phone reading bank messages, P2P payments aren't confirmed by themselves.", fix: { label: "Open P2P pay-ins", tab: "p2p" } });
    }
  }

  // 6. Limits.
  const lim = f.limits;
  const parts = [lim.min != null ? `from ${rupees(lim.min)}` : null, lim.max != null ? `up to ${rupees(lim.max)}` : lim.upiMax != null ? `up to ${rupees(lim.upiMax)}` : null, lim.daily != null ? `${rupees(lim.daily)} a day` : null].filter(Boolean);
  pass("LIMITS", "Limits", parts.length ? parts.join(", ") : "No limits set");

  // 7. The merchant's side: API login and payment messages.
  if (f.liveKey) pass("API_LOGIN", "API login", "Live key issued");
  else blockers.push({ key: "NO_LIVE_KEY", title: "No live API login", detail: "The merchant has no live Key + Salt to sign orders with.", fix: { label: "Open Developer", tab: "developer" } });
  const cb = f.callback;
  if (!cb.url) notes.push({ key: "NO_CALLBACK", title: "No callback URL", detail: "The merchant's server won't be told when a payment is paid.", fix: { label: "Open Integration", tab: "integration" } });
  else if (cb.lastOk === false) notes.push({ key: "CALLBACK_FAILING", title: "Payment messages aren't reaching the merchant", detail: `Last one ${ago(cb.lastAt, now)}${cb.lastHttp ? `: their server answered ${cb.lastHttp}` : ": no answer"}.`, fix: { label: "Open Integration", tab: "integration" } });
  else pass("CALLBACK", "Payment messages", cb.lastAt ? `Last delivered ${ago(cb.lastAt, now)}` : "Callback URL set");

  const ready = blockers.length === 0;
  const headline = ready
    ? `${f.code} would take a live order right now`
    : `${f.code} would refuse a live order right now`;
  return { ready, headline, blockers, notes, passed };
}
