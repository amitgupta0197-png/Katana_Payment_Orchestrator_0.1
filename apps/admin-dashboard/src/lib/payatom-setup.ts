// Guided PayAtom setup for one banker (components/merchant/payatom-connect.tsx). PURE: the plan
// of where each PayAtom account is saved, so staff answer "what should PayAtom do here?" and
// never have to know about main accounts, extra accounts or the MID switch.
//
// Katana uses PayAtom for P2P only (2026-10-12): its "Payin P2P Seamless" product, where the
// money lands in the banker's own bank account (channel P2P). PayAtom's Intent product (P2C, the
// money lands with PayAtom) is not offered: it cannot be saved, and an Intent order never uses a
// PayAtom account (lib/pg-catalog gatewayTakesIntent). An Intent account saved before then is
// shown as retired; saving P2P replaces it when it sits in the main account.
//
// A P2P order uses the banker's MAIN account (vault label gateway_mid), so PayAtom P2P is always
// the main account. Anything else already there is replaced only when the person says so.

export interface AccountNow {
  vault_label: string;
  gateway: string;
  channel: "P2P" | "INTENT";
}

export interface PayatomPlan {
  /** Where PayAtom P2P is saved: always the main account. */
  p2p: { label: string };
  /** The main account this replaces (another gateway, or a retired PayAtom Intent account), or null. */
  replaces: AccountNow | null;
}

export const MAIN = "gateway_mid";

export type PlanResult = { ok: true; plan: PayatomPlan } | { ok: false; code: "MAIN_TAKEN"; error: string; replaces?: AccountNow };

const isPayatom = (a: AccountNow | undefined, ch: "P2P" | "INTENT") => !!a && a.gateway === "PAYATOM" && a.channel === ch;

/** Where PayAtom P2P goes, given the banker's accounts now. */
export function planPayatom(accounts: AccountNow[], replaceMain: boolean): PlanResult {
  const main = accounts.find((a) => a.vault_label === MAIN);
  const replaces = !main || isPayatom(main, "P2P") ? null : main;
  if (replaces && !replaceMain) {
    return {
      ok: false, code: "MAIN_TAKEN", replaces,
      error: `this banker's main processor account is ${replaces.gateway === "PAYATOM" ? "a PayAtom Intent account (no longer used)" : replaces.gateway}; confirm to replace it`,
    };
  }
  return { ok: true, plan: { p2p: { label: MAIN }, replaces } };
}

/** What PayAtom does for a banker now: its P2P account, and any retired Intent account still saved. */
export function payatomNow(accounts: AccountNow[]): { p2p: AccountNow | null; retiredIntent: AccountNow | null } {
  const main = accounts.find((a) => a.vault_label === MAIN);
  return {
    p2p: isPayatom(main, "P2P") ? main! : null,
    retiredIntent: accounts.find((a) => isPayatom(a, "INTENT")) ?? null,
  };
}

/** A few places PayAtom accounts are commonly registered at; staff may type any other. */
export const LOCATION_PRESETS: { name: string; latitude: string; longitude: string }[] = [
  { name: "Mumbai", latitude: "19.0760", longitude: "72.8777" },
  { name: "Delhi", latitude: "28.6139", longitude: "77.2090" },
  { name: "Bengaluru", latitude: "12.9716", longitude: "77.5946" },
  { name: "Pune", latitude: "18.5204", longitude: "73.8567" },
];
