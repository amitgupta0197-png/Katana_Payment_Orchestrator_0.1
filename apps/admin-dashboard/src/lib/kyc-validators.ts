// KYB identifier checks that need no registry: the format and, where the identifier carries
// one, the check character. Pure. A value that passes here is well-formed, not verified —
// whether a GSTIN is active or a PAN belongs to the name is a registry's answer.

const B36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Upper-case with spaces and dashes removed, as identifiers are typed. */
export function tidyId(v: string | null | undefined): string {
  return (v ?? "").toUpperCase().replace(/[\s-]/g, "");
}

/** The check character a GSTIN's first 14 characters call for. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = B36.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return B36[(36 - (sum % 36)) % 36];
}

// 2 digits (state) + the 10-character PAN + entity number + 'Z' + check character.
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
// 5 letters (the 4th is the holder type) + 4 digits + 1 letter.
const PAN = /^[A-Z]{3}[ABCFGHJLPT][A-Z][0-9]{4}[A-Z]$/;
// 4 letters (bank) + '0' + 6 characters (branch).
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** Why a GSTIN is not well-formed, or null. */
export function gstinProblem(v: string): string | null {
  const g = tidyId(v);
  if (g.length !== 15) return "a GSTIN has 15 characters";
  if (!GSTIN.test(g)) return "not the shape of a GSTIN";
  const state = Number(g.slice(0, 2));
  if (state < 1 || state > 38) if (state !== 97 && state !== 99) return "the first two digits are not a state code";
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return "the check character does not match: one of the characters is wrong";
  return null;
}

/** The PAN inside a GSTIN (characters 3 to 12). */
export function gstinPan(gstin: string): string {
  return tidyId(gstin).slice(2, 12);
}

export function panProblem(v: string): string | null {
  const p = tidyId(v);
  if (p.length !== 10) return "a PAN has 10 characters";
  if (!PAN.test(p)) return "not the shape of a PAN";
  return null;
}

/** What kind of holder a PAN's 4th character says it belongs to. */
export function panHolderType(v: string): "INDIVIDUAL" | "COMPANY" | "FIRM" | "HUF" | "TRUST" | "OTHER" {
  switch (tidyId(v)[3]) {
    case "P": return "INDIVIDUAL";
    case "C": return "COMPANY";
    case "F": return "FIRM";
    case "H": return "HUF";
    case "T": return "TRUST";
    default: return "OTHER";
  }
}

export function ifscProblem(v: string): string | null {
  const c = tidyId(v);
  if (c.length !== 11) return "an IFSC has 11 characters";
  if (!IFSC.test(c)) return "not the shape of an IFSC: four letters, a zero, six characters";
  return null;
}

export function aadhaarLast4Problem(v: string): string | null {
  return /^[0-9]{4}$/.test(v.trim()) ? null : "the last four digits of the Aadhaar, digits only — never the full number";
}

/** A merchant category code is four digits. */
export function mccProblem(v: string): string | null {
  return /^[0-9]{4}$/.test(v.trim()) ? null : "a merchant category code has four digits";
}

// Categories a payment aggregator may not onboard (RBI PA/PG guidelines), by MCC.
const PROHIBITED_MCC: Record<string, string> = {
  "7995": "betting and gambling",
  "5993": "tobacco",
  "7273": "dating and escort services",
  "5967": "adult content",
};
// Categories that need a licence or a closer look before they are taken.
const REVIEW_MCC: Record<string, string> = {
  "6051": "quasi-cash and crypto assets",
  "6211": "securities dealers",
  "5933": "pawn shops",
  "4829": "money transfer",
};

export function mccStanding(mcc: string | null | undefined): { standing: "OK" | "REVIEW" | "PROHIBITED"; reason?: string } {
  const c = (mcc ?? "").trim();
  if (PROHIBITED_MCC[c]) return { standing: "PROHIBITED", reason: PROHIBITED_MCC[c] };
  if (REVIEW_MCC[c]) return { standing: "REVIEW", reason: REVIEW_MCC[c] };
  return { standing: "OK" };
}

// Words on a website that point to a prohibited line of business. Weak evidence: a match is
// a reason for a person to look, never a refusal by itself.
const PROHIBITED_WORDS = /\b(casino|betting|sportsbook|satta|matka|rummy cash|poker cash|escort|adult videos?|porn|firearms?|ammunition|cigarettes?|vape|hookah|crypto exchange|binary options|forex signals|mlm|get rich quick)\b/gi;

/** The prohibited-business words a page uses, each once, lower-cased. */
export function prohibitedWords(html: string): string[] {
  return [...new Set((html.match(PROHIBITED_WORDS) ?? []).map((w) => w.toLowerCase()))];
}
