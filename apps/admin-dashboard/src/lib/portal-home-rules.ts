// What the portals' Home asks a merchant or banker to do (lib/portal-home). PURE.
//
// Each "needs your attention" item and each go-live step carries one action: where to go to deal
// with it, in the portal the person is in. A step only Katana can do says so instead of linking.

import { istTime, rupees } from "@/lib/plain-words";

export type PortalBase = "/merchant-portal" | "/banker-portal";

export interface Action { label: string; href: string }
export interface AttentionItem {
  id: string;
  level: "urgent" | "warn" | "info";
  title: string;
  detail: string;
  action: Action | null;
}

export interface SetupStep { key: string; label: string; done: boolean; hint: string; action: Action | null; katana: boolean }

/** Where each go-live step is done. Null: Katana does it. */
export function stepAction(key: string, base: PortalBase, bankerId: string | null): { action: Action | null; katana: boolean } {
  switch (key) {
    case "webhook_url": return { action: { label: "Set webhook link", href: `${base}/webhooks` }, katana: false };
    case "test_payment": return { action: { label: "Make a test payment", href: `${base}/integration` }, katana: false };
    case "test_payout": return { action: { label: "Send a test payout", href: `${base}/integration` }, katana: false };
    case "onboarding":
      return base === "/merchant-portal"
        ? { action: { label: "Check documents", href: `${base}/kyc` }, katana: true }
        : { action: null, katana: true };
    case "settlement_vpa": case "payin_gateway": return { action: null, katana: true };
    default: return { action: bankerId && base === "/merchant-portal" ? { label: "Open", href: `${base}/bankers/${bankerId}` } : null, katana: false };
  }
}

/** Where live mode is asked for once every step is done. */
export function requestLiveAction(base: PortalBase, bankerId: string | null): Action {
  return base === "/banker-portal" || !bankerId
    ? { label: "Ask for live mode", href: `${base}/integration` }
    : { label: "Ask for live mode", href: `${base}/bankers/${bankerId}` };
}

/** A question for the assistant, or the help page when the assistant is off. */
export function askAction(base: PortalBase, assistant: boolean, question: string, label = "Ask the assistant"): Action {
  return assistant
    ? { label, href: `${base}/assistant?ask=${encodeURIComponent(question)}` }
    : { label: "Get help", href: base === "/merchant-portal" ? `${base}/tickets` : `${base}/help` };
}

export interface LateMoney { amount: number; utr: string | null; paid_at: string; order_txnid: string; order_status: string }

export function lateMoneyItem(m: LateMoney, base: PortalBase, now = new Date()): AttentionItem {
  return {
    id: `late:${m.utr ?? m.order_txnid}`,
    level: "urgent",
    title: `${rupees(m.amount)} came in after order ${m.order_txnid} ${m.order_status === "FAILED" ? "failed" : "expired"}`,
    detail: `Paid at ${istTime(m.paid_at, now)}${m.utr ? `, UTR ${m.utr}` : ""}. It is not linked to the order yet.`,
    action: { label: "See what happened", href: `${base}/find?q=${encodeURIComponent(m.utr ?? m.order_txnid)}` },
  };
}

export function webhookItem(dead: number, retrying: number, base: PortalBase): AttentionItem | null {
  if (!dead && !retrying) return null;
  const n = dead + retrying;
  return {
    id: "webhooks",
    level: dead ? "urgent" : "warn",
    title: `${n} payment message${n === 1 ? "" : "s"} did not reach your server`,
    detail: dead
      ? `We stopped trying ${dead === 1 ? "one" : dead} of them. Your system may not know these orders were paid.`
      : "We are still trying. Check that your webhook link is working.",
    action: { label: "Check webhooks", href: `${base}/webhooks` },
  };
}

export function payoutItem(p: { held: number; failed: number; returned: number }, base: PortalBase, assistant: boolean): AttentionItem | null {
  const parts = [
    p.failed && `${p.failed} failed`, p.held && `${p.held} on hold`, p.returned && `${p.returned} returned by the bank`,
  ].filter(Boolean) as string[];
  if (!parts.length) return null;
  return {
    id: "payouts",
    level: p.failed || p.returned ? "urgent" : "warn",
    title: `Payouts: ${parts.join(", ")}`,
    detail: p.held && !p.failed && !p.returned ? "Waiting for a second approval at Katana. Nothing to do yet." : "In the last two days.",
    action: askAction(base, assistant, "Why did my last payout fail?", "Find out why"),
  };
}

export function apiErrorItem(errors: number, lastCode: string | null, base: PortalBase): AttentionItem | null {
  if (errors < 3) return null;
  return {
    id: "api",
    level: "warn",
    title: `${errors} requests from your system were refused today`,
    detail: lastCode ? `The last one: ${lastCode}. Your developer can see each one in the API log.` : "Your developer can see each one in the API log.",
    action: { label: "Open API log", href: `${base}/api-log` },
  };
}

export function blockedItem(base: PortalBase): AttentionItem {
  return {
    id: "blocked",
    level: "urgent",
    title: "Your account is paused",
    detail: "New orders are refused until Katana turns it back on.",
    action: { label: "Contact Katana", href: base === "/merchant-portal" ? `${base}/tickets` : `${base}/help` },
  };
}

const LEVEL_ORDER = { urgent: 0, warn: 1, info: 2 } as const;
export const sortAttention = (items: AttentionItem[]) => [...items].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
