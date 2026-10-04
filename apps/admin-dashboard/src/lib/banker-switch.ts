// THE BANKER SWITCH: a merchant's pay-in traffic between its own bankers (vendorGateway 0042).
//
// PURE. A merchant (provider) holds a Key + Salt for each of its bankers. With the switch on, an
// order signed with any of those Keys is offered to the merchant's bankers in the order decided
// here: the banker switched to by hand first (while the pin lasts), then the bankers in rotation by
// PRIORITY (lowest number first; ties go to the one with fewer orders today) or WEIGHTED (a random
// order drawn by weight). lib/katana-order tries each in turn and passes over one that cannot take
// the order (blocked, not live, over a limit, wrong flow, no MID free, no Key for the mode).
//
// The order then belongs to the banker that took it. Traffic never leaves the merchant.

export const BANKER_SWITCH_MODES = ["PRIORITY", "WEIGHTED"] as const;
export type BankerSwitchMode = (typeof BANKER_SWITCH_MODES)[number];

export interface BankerSwitchSettings {
  enabled: boolean;
  mode: BankerSwitchMode;
  pinned_banker: string | null;
  pinned_until: string | null;
  pin_reason: string | null;
  last_banker: string | null;
}

export interface BankerMember {
  banker_code: string;
  in_rotation: boolean;
  priority: number;
  weight: number;
}

export const DEFAULT_BANKER_SWITCH: BankerSwitchSettings = {
  enabled: false, mode: "PRIORITY", pinned_banker: null, pinned_until: null, pin_reason: null, last_banker: null,
};

/** A banker with no row of its own: in rotation, middle priority, weight 1. */
export const defaultMember = (banker_code: string): BankerMember => ({ banker_code, in_rotation: true, priority: 10, weight: 1 });

/** The banker switched to by hand, while the pin lasts and the banker is still the merchant's. */
export function activePin(s: BankerSwitchSettings, bankers: string[], now: Date): string | null {
  if (!s.pinned_banker || !bankers.includes(s.pinned_banker)) return null;
  if (s.pinned_until && Date.parse(s.pinned_until) <= now.getTime()) return null;
  return s.pinned_banker;
}

export type PickHow = "PINNED" | "PRIORITY" | "WEIGHTED";
export interface BankerCandidate { banker: string; how: PickHow }

/**
 * The order the merchant's bankers are offered an order in. A pinned banker comes first even when
 * out of rotation (switching to it by hand is the point); with WEIGHTED, a weight of 0 keeps a
 * banker out unless it is pinned.
 */
export function bankerOrder(
  members: BankerMember[], s: BankerSwitchSettings, now: Date,
  o: { random?: () => number; ordersToday?: Record<string, number> } = {},
): BankerCandidate[] {
  const random = o.random ?? Math.random;
  const today = (b: string) => o.ordersToday?.[b] ?? 0;
  const pin = activePin(s, members.map((m) => m.banker_code), now);
  const out: BankerCandidate[] = pin ? [{ banker: pin, how: "PINNED" }] : [];
  const pool = members.filter((m) => m.in_rotation && m.banker_code !== pin);
  if (s.mode === "WEIGHTED") {
    const left = pool.filter((m) => m.weight > 0);
    while (left.length) {
      const total = left.reduce((n, m) => n + m.weight, 0);
      let r = random() * total, i = 0;
      for (; i < left.length - 1; i++) { r -= left[i].weight; if (r < 0) break; }
      out.push({ banker: left[i].banker_code, how: "WEIGHTED" });
      left.splice(i, 1);
    }
  } else {
    [...pool]
      .sort((a, b) => a.priority - b.priority || today(a.banker_code) - today(b.banker_code) || a.banker_code.localeCompare(b.banker_code))
      .forEach((m) => out.push({ banker: m.banker_code, how: "PRIORITY" }));
  }
  return out;
}

/** Why a banker was passed over, from the error its order attempt raised (codes the screens explain). */
export const PASS_OVER_WORDS: Record<string, string> = {
  NO_KEY: "has no Key for this mode",
  MERCHANT_BLOCKED: "is blocked",
  MERCHANT_SUSPENDED: "is suspended",
  PAYIN_NOT_ENABLED: "does not take pay-ins",
  LIVE_MODE_NOT_ACTIVATED: "is not live yet",
  FLOW_NOT_SELECTED: "has no pay-in flow selected",
  FLOW_NOT_ENABLED: "is not on this flow",
  FLOW_NOT_READY: "is not set up for this flow",
  NO_ACCOUNT_AVAILABLE: "has no account free (limits, hours or health)",
  ACCOUNT_NOT_LIVE: "has an account still being verified",
  TXNID_IN_USE: "already has an order with this txnid",
  LIMIT: "is over a pay-in limit",
  SETUP: "is not set up to take this order",
  PROCESSOR_ERROR: "could not create the order with its processor",
};

export const passOverWords = (code: string) => PASS_OVER_WORDS[code] ?? "could not take the order";
