// Guided PayAtom setup for one banker (components/merchant/payatom-connect.tsx). PURE: the plan
// of where each PayAtom account is saved, so staff answer "what should PayAtom do here?" and
// never have to know about main accounts, extra accounts or the MID switch.
//
// PayAtom has two products, one per Katana flow:
//   P2P     Payin P2P Seamless  money lands in the banker's own bank account (channel P2P)
//   INTENT  Payin P2C Seamless  money lands with PayAtom, which settles to the banker (channel INTENT)
//
// How Katana routes (lib/katana-order): a P2P order uses the banker's MAIN account (vault label
// gateway_mid); an Intent order uses the main account too, unless the banker's MID switch has
// processor accounts, when it uses one of those. So:
//   P2P only     PayAtom P2P is the main account.
//   Intent only  PayAtom Intent is the main account.
//   Both         PayAtom P2P is the main account; PayAtom Intent is an extra account, put in the
//                MID switch (switched on) so Intent orders find it.
// Anything else already in the main account is replaced only when the person says so.

export type PayatomProduct = "P2P" | "INTENT";

export interface AccountNow {
  vault_label: string;
  gateway: string;
  channel: "P2P" | "INTENT";
}

export interface PayatomPlan {
  /** Where each product is saved: "main", an existing extra account's label, or "new". */
  p2p: { label: string } | null;
  intent: { label: string; addToSwitch: boolean } | null;
  /** The main account this replaces (a different gateway or product), or null. */
  replaces: AccountNow | null;
}

export const MAIN = "gateway_mid";

export type PlanResult = { ok: true; plan: PayatomPlan } | { ok: false; code: "NOTHING_CHOSEN" | "MAIN_TAKEN"; error: string; replaces?: AccountNow };

const isPayatom = (a: AccountNow | undefined, ch: "P2P" | "INTENT") => !!a && a.gateway === "PAYATOM" && a.channel === ch;

/** Where PayAtom's accounts go for what is wanted, given the banker's accounts now. */
export function planPayatom(accounts: AccountNow[], want: { p2p: boolean; intent: boolean }, replaceMain: boolean): PlanResult {
  if (!want.p2p && !want.intent) return { ok: false, code: "NOTHING_CHOSEN", error: "choose what PayAtom should do for this banker" };
  const main = accounts.find((a) => a.vault_label === MAIN);
  const extraIntent = accounts.find((a) => a.vault_label !== MAIN && isPayatom(a, "INTENT"));
  // The main account a product needs, and whether something else sits there now.
  const mainProduct: PayatomProduct = want.p2p ? "P2P" : "INTENT";
  const mainIsOurs = !main || isPayatom(main, mainProduct);
  // Both, with PayAtom Intent in the main account today: it moves to an extra account, so the
  // main can take P2P. That is a move of PayAtom's own account, not a replacement of another one.
  const intentMovesOut = want.p2p && want.intent && isPayatom(main, "INTENT");
  const replaces = mainIsOurs || intentMovesOut ? null : main!;
  if (replaces && !replaceMain) {
    return {
      ok: false, code: "MAIN_TAKEN", replaces,
      error: `this banker's main processor account is ${replaces.gateway === "PAYATOM" ? `PayAtom ${replaces.channel === "P2P" ? "P2P" : "Intent"}` : replaces.gateway}; confirm to replace it`,
    };
  }
  const plan: PayatomPlan = { p2p: null, intent: null, replaces };
  if (want.p2p) plan.p2p = { label: MAIN };
  if (want.intent) {
    plan.intent = want.p2p
      ? { label: extraIntent?.vault_label ?? "new", addToSwitch: true }
      : { label: MAIN, addToSwitch: false };
  }
  return { ok: true, plan };
}

/** What PayAtom does for a banker now, read from its accounts. */
export function payatomNow(accounts: AccountNow[], intentInSwitch: boolean): { p2p: AccountNow | null; intent: AccountNow | null; intentReachable: boolean } {
  const main = accounts.find((a) => a.vault_label === MAIN);
  const p2p = isPayatom(main, "P2P") ? main! : null;
  const intent = isPayatom(main, "INTENT") ? main! : accounts.find((a) => a.vault_label !== MAIN && isPayatom(a, "INTENT")) ?? null;
  // An Intent account that is not the main one is only used through the MID switch.
  const intentReachable = !!intent && (intent.vault_label === MAIN || intentInSwitch);
  return { p2p, intent, intentReachable };
}

/** A few places PayAtom accounts are commonly registered at; staff may type any other. */
export const LOCATION_PRESETS: { name: string; latitude: string; longitude: string }[] = [
  { name: "Mumbai", latitude: "19.0760", longitude: "72.8777" },
  { name: "Delhi", latitude: "28.6139", longitude: "77.2090" },
  { name: "Bengaluru", latitude: "12.9716", longitude: "77.5946" },
  { name: "Pune", latitude: "18.5204", longitude: "73.8567" },
];
