// The banker page's "What's left": five steps from sign-up to taking live money, each ticked from
// real state, never by a click that claims it. Pure; the facts are lib/banker-check's plus what
// the onboarding steps, the go-live checklist and the banker's paid orders say
// (lib/banker-check-store bankerTodoFacts).

import type { BankerCheckFacts } from "@/lib/banker-check";
import { defaultOrderFlow } from "@/lib/banker-check";
import { allowsPayin } from "@/lib/merchant-services";

export interface BankerTodoFacts {
  check: BankerCheckFacts;
  /** Onboarding steps (merchants.step_*). */
  steps: { application: boolean; kyb: boolean; screening: boolean; bankVerify: boolean; approval: boolean };
  /** The go-live checklist's proof on the first payment account (gateway_golive), when it has a row. */
  golive: null | { webhookAt: string | null; statusAt: string | null };
  /** Paid live pay-ins of this banker, by channel. */
  livePaid: { intent: number; p2p: number };
}

export type TodoStepKey = "DETAILS" | "FLOW" | "ACCOUNT" | "TEST_PAYMENT" | "GO_LIVE";

export interface TodoStep {
  key: TodoStepKey;
  n: number;
  title: string;
  detail: string;
  done: boolean;
  /** Set when an earlier step isn't done: "Needs step 3 first". */
  waitingFor: number | null;
  action?: { label: string; tab?: string; href?: string; kind?: "advance" };
  /** Shown under a done step: who / what did it. */
  doneNote?: string;
}

export interface BankerTodo {
  live: boolean;
  headline: string;
  summary: string;
  done: number;
  total: number;
  steps: TodoStep[];
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function bankerTodo(t: BankerTodoFacts): BankerTodo {
  const f = t.check;
  const payin = allowsPayin(f.services);
  const flow = defaultOrderFlow(f.flow);
  const a = f.account;
  const intentAccount = !!a && a.channel === "INTENT" && a.connector && a.env === "PROD";
  const p2pReady = !!f.upiId || (!!a && a.channel === "P2P");

  const detailsDone = t.steps.application && t.steps.kyb && t.steps.screening && t.steps.bankVerify;
  // No flow chosen is the routing every banker had before flows (lib/payin-flow UNSET): it takes
  // live orders as long as something can take them, so it only counts as missing with nothing set up.
  const legacyRouted = f.flow.flow === "UNSET" && (intentAccount || p2pReady);
  const flowDone = !payin || f.flow.flow !== "UNSET" || legacyRouted;
  const accountDone = !payin || (flow === "P2P" ? p2pReady : flow === "INTENT" ? intentAccount : intentAccount || p2pReady);
  const onIntent = payin && flow !== "P2P" && (flow === "INTENT" || intentAccount);
  const testDone = !payin || (onIntent
    ? (t.golive ? (!!t.golive.webhookAt && !!t.golive.statusAt) || a?.golive === "LIVE" : t.livePaid.intent > 0 || a?.golive === "LIVE")
    : t.livePaid.p2p > 0);
  const goLiveDone = t.steps.approval && f.liveActivated && (!onIntent || a?.golive !== "VERIFYING");

  const amount = onIntent ? (a?.minAmount ?? null) : 1;
  const flowWords = flow === "P2P" ? "Customer pays the banker's UPI ID" : flow === "INTENT" ? "Through a payment gateway" : f.flow.flow === "BOTH" ? "Both flows"
    : legacyRouted ? "Not chosen: orders are routed as before (you can choose one)" : "Not chosen";

  const raw: Omit<TodoStep, "n" | "waitingFor">[] = [
    {
      key: "DETAILS", title: "Business details and documents", done: detailsDone,
      detail: detailsDone ? "Application, documents, screening and bank check done." : "Application, documents, screening and the bank account check.",
      action: { label: "Open onboarding steps", kind: "advance" },
    },
    {
      key: "FLOW", title: "How customers pay", done: flowDone,
      detail: payin ? flowWords : "Payouts only: no pay-in flow needed.",
      action: { label: flowDone ? "Change" : "Choose", tab: "overview" },
    },
    {
      key: "ACCOUNT", title: flow === "P2P" ? "Save the UPI ID money lands on" : "Connect the payment account", done: accountDone,
      detail: !payin ? "Not needed for a payouts-only merchant."
        : flow === "P2P" ? (p2pReady ? `UPI ID ${f.upiId ?? "via the processor account"}` : "The UPI ID the customer pays. Without it a live order has nowhere to land.")
        : intentAccount ? `${a!.gatewayName} account (${a!.checkout === "H2H" ? "host-to-host" : "redirect"})`
        : a && a.channel === "INTENT" && a.env !== "PROD" ? `${a.gatewayName} is connected with test credentials. Live orders need its live ones.`
        : "The gateway account the customer's money is paid into. You'll need its ID, key and secret from the gateway.",
      action: { label: accountDone ? "Open" : "Connect", tab: flow === "P2P" ? "p2p" : "intent" },
    },
    {
      key: "TEST_PAYMENT", title: amount ? `Make one real ${rupees(amount)} payment` : "Make one real payment", done: testDone,
      detail: !payin ? "Not needed for a payouts-only merchant."
        : testDone ? "A real payment was paid and confirmed." : "Pay it yourself with a QR or link Katana makes. Proves money arrives and we hear about it.",
      action: { label: "Start test", tab: onIntent ? "intent" : "p2p" },
    },
    {
      key: "GO_LIVE", title: "Approve and switch on live payments", done: goLiveDone,
      detail: goLiveDone ? "Live payments are on."
        : !t.steps.approval ? "A Super Admin approves the banker. Its live key starts working when live mode is on."
        : !f.liveActivated ? "Approved. Switch on live mode."
        : "Live mode is on. Mark the payment account live on Gateway go-live to lift the verification cap.",
      action: !t.steps.approval ? { label: "Approve", kind: "advance" }
        : !f.liveActivated ? { label: "Open live mode", tab: "developer" }
        : { label: "Open Gateway go-live", href: "/gateway-golive" },
    },
  ];
  let firstOpen: number | null = null;
  const steps: TodoStep[] = raw.map((s, i) => {
    const n = i + 1;
    const waitingFor = !s.done && firstOpen !== null ? firstOpen : null;
    if (!s.done && firstOpen === null) firstOpen = n;
    return { ...s, n, waitingFor };
  });
  const done = steps.filter((s) => s.done).length;
  const live = done === steps.length;
  return {
    live, done, total: steps.length, steps,
    headline: live ? `${f.code} takes live payments` : `${f.code} can't take live payments yet`,
    summary: live ? "Every step is done." : `${done} of ${steps.length} steps are done. Live orders are refused until the rest are, so nothing is lost.`,
  };
}
