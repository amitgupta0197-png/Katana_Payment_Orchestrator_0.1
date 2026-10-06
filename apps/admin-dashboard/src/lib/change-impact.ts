// "Before you save": what a risky change to a banker would do to the orders it takes, in plain
// words, from its recent orders (lib/change-impact-store). The screens show it and let the person
// go ahead or keep things as they are; the server's behaviour is not changed by it.

export type ImpactChange = "PARTNER_EXCLUSIVE" | "FLOW" | "ACCOUNT" | "BLOCK";

export interface BankerOrderCounts {
  code: string;
  /** Live orders in the window, all channels. */
  total: number;
  intent: number;
  p2p: number;
  /** Not made through the partner API (signed with the banker's own key). */
  own: number;
  /** Still open (PENDING) now. */
  open: number;
  lastAt: string | null;
}

export interface Impact {
  /** Nothing would stop: the screen saves without asking. */
  none: boolean;
  title: string;
  /** Plain-words paragraphs. */
  body: string[];
  /** The rows shown in the box: what, and how many. */
  rows: { label: string; value: string }[];
  keepLabel: string;
  proceedLabel: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string | null) => iso
  ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })
  : "—";

/** Making a partner exclusive: its bankers stop taking orders signed with their own keys. */
export function exclusiveImpact(partner: string, bankers: BankerOrderCounts[], days: number): Impact {
  const hit = bankers.filter((b) => b.own > 0);
  const who = hit.length === 1 ? hit[0].code : `${hit.length} of its bankers`;
  return {
    none: hit.length === 0,
    title: `This will stop ${hit.length === 1 ? `${hit[0].code}'s` : "its bankers'"} own orders`,
    body: [
      `Making ${partner} an exclusive partner means its bankers take partner orders only. Right now ${who} ${hit.length === 1 ? "takes" : "take"} orders another way too:`,
      `From the moment you save, those orders will be refused with "partner API only".`,
    ],
    rows: hit.flatMap((b) => [
      { label: `${b.code} · its own live key`, value: `${plural(b.own, "order")} in ${days} days` },
      { label: "Last one", value: day(b.lastAt) },
    ]),
    keepLabel: "Keep its own orders working",
    proceedLabel: "Partner orders only",
  };
}

/** Changing a banker's flow. `ready` = the new flow has what it needs (UPI ID / payment account). */
export function flowImpact(code: string, to: "P2P" | "INTENT" | "BOTH" | "UNSET", c: BankerOrderCounts, ready: boolean, days: number): Impact {
  const leaving = to === "P2P" ? c.intent : to === "INTENT" ? c.p2p : 0;
  const leavingWord = to === "P2P" ? "Intent" : "P2P";
  const body: string[] = [];
  if (leaving) body.push(`${code} took ${plural(leaving, `${leavingWord} order`)} in the last ${days} days. After this, orders that ask for ${leavingWord} are refused, and orders that name no flow go ${to === "P2P" ? "to its UPI ID" : "through its payment account"}.`);
  if (!ready && to !== "UNSET") body.push(to === "P2P"
    ? "It has no UPI ID for P2P payments to land on, so every live order will be refused until one is saved."
    : "It has no live payment account for Intent, so every live order will be refused until one is connected.");
  if (c.open) body.push(`${plural(c.open, "order")} still open keep the flow they were made on.`);
  return {
    none: !leaving && (ready || to === "UNSET"),
    title: !ready && to !== "UNSET" ? `${code} won't be able to take live orders` : `This changes where ${code}'s orders go`,
    body,
    rows: [{ label: `Orders in ${days} days`, value: `${c.intent} Intent · ${c.p2p} P2P` }, { label: "Last one", value: day(c.lastAt) }],
    keepLabel: "Keep the current flow",
    proceedLabel: "Change the flow",
  };
}

/** Replacing the banker's first payment account. */
export function accountImpact(code: string, current: string | null, next: string, c: BankerOrderCounts, days: number): Impact {
  const body = [
    `New orders go through ${next} from the moment you save.`,
    ...(c.open ? [`${plural(c.open, "order")} still open on the current account will be checked with the new credentials. If they were made on another gateway account, their status can't be confirmed from it any more.`] : []),
    ...(current && current !== next ? [`A new account starts in verification: only small payments until one real payment is confirmed and it is set live on Gateway go-live.`] : []),
  ];
  return {
    none: c.total === 0 && c.open === 0,
    title: `This replaces ${code}'s payment account${current ? ` (${current})` : ""}`,
    body,
    rows: [{ label: `Intent orders in ${days} days`, value: String(c.intent) }, { label: "Open now", value: String(c.open) }, { label: "Last one", value: day(c.lastAt) }],
    keepLabel: "Keep the current account",
    proceedLabel: "Replace it",
  };
}

/** Blocking a banker. */
export function blockImpact(code: string, c: BankerOrderCounts, days: number): Impact {
  return {
    none: false,
    title: `This stops ${code} taking new payments`,
    body: [
      c.total ? `It took ${plural(c.total, "live order")} in the last ${days} days. New orders are refused from the moment you save.` : "New orders are refused from the moment you save.",
      ...(c.open ? [`${plural(c.open, "order")} already open can still be paid.`] : []),
    ],
    rows: [{ label: `Live orders in ${days} days`, value: String(c.total) }, { label: "Last one", value: day(c.lastAt) }],
    keepLabel: "Keep it taking payments",
    proceedLabel: "Block it",
  };
}
