// A merchant's code from its name, and the next free one when it is taken. PURE: the create
// journey and the code API use the same rules.

const NOISE = new Set(["PVT", "PRIVATE", "LTD", "LIMITED", "LLP", "INC", "THE", "AND", "CO", "COMPANY", "OF"]);

export const MERCHANT_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,59}$/;

/** "Acme Retail Pvt Ltd" → "ACME-RETAIL". Empty when the name has nothing to build one from. */
export function codeFromName(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter((w) => w && !NOISE.has(w));
  const code = words.slice(0, 2).join("-").slice(0, 24).replace(/-+$/, "");
  return code.length >= 2 ? code : "";
}

/** The base itself when free, else BASE-2, BASE-3, … — the first one not in `taken`. */
export function nextFreeCode(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((c) => c.toUpperCase()));
  if (!used.has(base.toUpperCase())) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`.toUpperCase())) return `${base}-${i}`;
}
