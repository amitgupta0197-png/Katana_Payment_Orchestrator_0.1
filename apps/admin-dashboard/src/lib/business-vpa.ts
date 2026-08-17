// Which BUSINESS received the payment, and therefore which UPI ID.
//
// One Google Pay for Business app holds several businesses. A live merchant runs four from a
// single phone — "Mr Ayan Sulemani · Shop No 13 / 14 / 15 / 16, Kahrai, Agra" — each with its
// own UPI ID, which is exactly why the banker has four settlement VPAs configured.
//
// That breaks the two simpler models:
//   • the payment does not name its destination (no VPA in any of 76 captured credits), so it
//     cannot be read off the credit itself;
//   • the PHONE does not identify it either, because one phone serves all four businesses —
//     mapping per device would stamp one shop's UPI ID onto the other three's money.
//
// What can identify it is the business marker the capture reports — a shop label from the
// notification or the payment's detail screen. This module turns that marker into a UPI ID
// using a per-banker map the operator configures once, next to the VPA list it draws from.
//
// The marker is fuzzy on purpose: a notification may say "Shop No 13" where the configured
// entry reads "Shop No 13, Kahrai, Agra". Matching is therefore normalise-then-contain, in
// either direction, with a minimum length so a two-character fragment cannot match half the
// shops. Anything ambiguous resolves to nothing — an unknown destination is shown honestly,
// whereas a wrong one silently misattributes money.

/** One configured business → UPI ID pair, as stored in the banker's `poolpay` config. */
export interface BusinessVpa {
  /** Shop / business label as the payment app shows it. */
  marker: string;
  /** UPI ID that business collects on — always one of the banker's settlement VPAs. */
  vpa: string;
}

/** Shortest marker we will match on. Below this a fragment is not evidence of anything. */
const MIN_MARKER = 4;

/**
 * Comparable form of a label: lowercase, punctuation folded to single spaces. "Shop No 13,
 * Kahrai" and "shop no 13 kahrai" must compare equal, because the same shop is written both
 * ways by the app and by the person configuring it.
 */
export function normaliseMarker(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** The configured business→VPA pairs from a banker's `poolpay` blob, cleaned and deduped. */
export function businessVpasFromConfig(poolpay: unknown): BusinessVpa[] {
  const raw = (poolpay as { business_vpas?: unknown } | null)?.business_vpas;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: BusinessVpa[] = [];
  for (const e of raw) {
    const marker = typeof (e as BusinessVpa)?.marker === "string" ? (e as BusinessVpa).marker.trim() : "";
    const vpa = typeof (e as BusinessVpa)?.vpa === "string" ? (e as BusinessVpa).vpa.trim().toLowerCase() : "";
    const key = normaliseMarker(marker);
    if (!marker || !vpa || key.length < MIN_MARKER || seen.has(key)) continue;
    seen.add(key);
    out.push({ marker, vpa });
  }
  return out;
}

/**
 * Resolve a UPI ID from whatever text the capture gave us.
 *
 * `candidates` are strings that might contain a business label — the agent's explicit
 * `business` field first, then detail-screen values, then the raw notification text. The first
 * candidate that matches EXACTLY ONE configured business wins; a candidate matching several
 * (two shops sharing a name prefix) is skipped rather than guessed at.
 *
 * `allowed`, when given, is the banker's configured settlement VPA list — a resolved VPA
 * outside it means the map has drifted from the config and is rejected, so a stale entry
 * cannot attribute money to an account the banker no longer holds.
 */
export function resolveBusinessVpa(
  entries: BusinessVpa[],
  candidates: (string | null | undefined)[],
  allowed?: string[],
): { vpa: string; marker: string } | null {
  if (!entries.length) return null;
  const allow = allowed?.length ? new Set(allowed.map((v) => v.trim().toLowerCase())) : null;

  for (const candidate of candidates) {
    const hay = normaliseMarker(candidate);
    if (hay.length < MIN_MARKER) continue;
    const scored = entries
      .map((e) => ({ e, needle: normaliseMarker(e.marker) }))
      .filter(({ needle }) => needle.length >= MIN_MARKER);

    // MATCHING IS BY WHOLE TOKENS, NEVER RAW SUBSTRING. Shop labels differ by their last
    // token, so "shop no 1" sits inside the string "shop no 16" and a substring test would
    // send Shop 16's money to Shop 1. Padding both sides makes the comparison token-aligned:
    // " shop no 1 " is not inside " shop no 16 ", while " shop no 15 " is inside
    // " mr ayan shop no 15 kahrai agra ".
    const pad = (s: string) => ` ${s} `;
    const contains = (outer: string, inner: string) => pad(outer).includes(pad(inner));

    // 1) Exact — the capture named the business exactly as configured.
    const exact = scored.filter(({ needle }) => needle === hay);
    // 2) FORWARD: the captured text CONTAINS a configured label (a notification line with the
    //    shop inside it). More tokens matched = more specific, so the longest label wins.
    const forward = scored.filter(({ needle }) => needle !== hay && contains(hay, needle));
    // 3) REVERSE: the capture is a FRAGMENT of a configured label ("Shop No 13" against
    //    "Shop No 13, Kahrai, Agra"). Here "longest wins" must NOT apply: a generic fragment
    //    like "shop" is a fragment of every label, and picking the longest would silently
    //    attribute money to whichever shop has the wordiest address. A fragment therefore only
    //    counts when it fits exactly one label.
    const reverse = scored.filter(({ needle }) => needle !== hay && contains(needle, hay));

    let best: { e: BusinessVpa; needle: string } | null = null;
    if (exact.length === 1) best = exact[0];
    else if (forward.length) {
      const longest = forward.reduce((a, b) => (b.needle.length > a.needle.length ? b : a));
      if (forward.filter(({ needle }) => needle.length === longest.needle.length).length === 1) best = longest;
    } else if (reverse.length === 1) best = reverse[0];
    if (!best) continue;                                   // nothing, or genuinely ambiguous

    const vpa = best.e.vpa.trim().toLowerCase();
    if (allow && !allow.has(vpa)) continue;                // map drifted from the config
    return { vpa, marker: best.e.marker };
  }
  return null;
}
