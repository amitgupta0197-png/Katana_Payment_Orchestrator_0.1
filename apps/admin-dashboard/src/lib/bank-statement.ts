// Bank statement files, read into entries: SWIFT MT940 and ISO 20022 camt.053. Pure — no
// database; POST /api/v1/bank-feeds/{bank_code} feeds the credits to the reconciler.
//
// Written out rather than pulled from a dependency, like the Paytm statement parser: these
// files state money, and how they are read must not become a supply-chain question. Both
// readers are tolerant of what banks actually send (wrapped lines, SWIFT envelope blocks,
// XML namespace prefixes) and strict about what they report: an entry whose amount or
// direction cannot be read is returned in `problems`, never guessed.
//
// A statement gives a DATE, not a time, for most entries. `time` is set only when the file
// states one (camt.053 BookgDt/DtTm).

export type StatementFormat = "MT940" | "CAMT053";

export interface StatementEntry {
  direction: "CREDIT" | "DEBIT";
  /** A reversal of an earlier entry (MT940 RC / RD, camt RvslInd). */
  reversal: boolean;
  amount: number;
  currency: string | null;
  /** The value date, YYYY-MM-DD. */
  date: string;
  /** ISO time of booking when the file states one, else null. */
  time: string | null;
  /** The 12-digit UPI / IMPS reference found in the entry, when there is exactly one candidate. */
  rrn: string | null;
  /** The bank's and the customer's own references, as stated. */
  bankRef: string | null;
  customerRef: string | null;
  payerVpa: string | null;
  payerName: string | null;
  narration: string;
}

export interface ParsedStatement {
  format: StatementFormat;
  account: string | null;
  currency: string | null;
  opening: number | null;
  closing: number | null;
  entries: StatementEntry[];
  /** Entries that could not be read, with why. */
  problems: string[];
}

export function detectFormat(text: string): StatementFormat | null {
  if (/<(?:\w+:)?BkToCstmrStmt[\s>]/.test(text)) return "CAMT053";
  if (/^:20:/m.test(text) && /^:6[01][FM]?:/m.test(text)) return "MT940";
  return null;
}

/** The 12-digit payment reference in a text, when it holds exactly one. Two candidates is not one answer. */
export function rrnIn(text: string): string | null {
  const found = [...new Set(text.match(/(?<![0-9])[0-9]{12}(?![0-9])/g) ?? [])];
  return found.length === 1 ? found[0] : null;
}

const VPA = /[a-z0-9._-]{2,}@[a-z][a-z0-9]{1,}/i;

// ── MT940 ────────────────────────────────────────────────────────────────────

const money = (v: string) => Number(v.replace(",", "."));
const ymd = (yy: string, mm: string, dd: string) => `${Number(yy) >= 70 ? "19" : "20"}${yy}-${mm}-${dd}`;

// :61:  value date YYMMDD, optional entry date MMDD, mark C / D / RC / RD, optional funds
// letter, amount with a comma, transaction type (a letter and three characters), the
// customer's reference, then // and the bank's reference.
const LINE_61 = /^(\d{2})(\d{2})(\d{2})(\d{4})?(RC|RD|C|D)([A-Z])?(\d+,\d{0,2})([NFS][A-Z0-9]{3})([^/\n]*)(?:\/\/([^\n]*))?/;
// :60F: / :62F:  C or D, date, currency, amount.
const BALANCE = /^([CD])(\d{6})([A-Z]{3})(\d+,\d{0,2})/;

export function parseMt940(text: string): ParsedStatement {
  const out: ParsedStatement = { format: "MT940", account: null, currency: null, opening: null, closing: null, entries: [], problems: [] };
  // A field runs from its tag to the next tag; its lines may wrap.
  const body = text.replace(/\r\n?/g, "\n");
  const fields = [...body.matchAll(/^:(\d{2}[A-Z]?):([\s\S]*?)(?=^:\d{2}[A-Z]?:|^-\}?$|\n-\}|(?![\s\S]))/gm)];
  let last: StatementEntry | null = null;
  for (const [, tag, rawValue] of fields) {
    const value = rawValue.replace(/\n+$/, "");
    if (tag === "25") out.account = value.trim().split("\n")[0] || null;
    else if (tag === "60F" || tag === "60M" || tag === "62F" || tag === "62M") {
      const b = value.trim().match(BALANCE);
      if (!b) { out.problems.push(`:${tag}: balance not readable: ${value.trim().slice(0, 40)}`); continue; }
      const amount = money(b[4]) * (b[1] === "D" ? -1 : 1);
      out.currency = b[3];
      if (tag.startsWith("60")) { if (out.opening == null) out.opening = amount; } else out.closing = amount;
    } else if (tag === "61") {
      const lines = value.split("\n");
      const m = lines[0].match(LINE_61);
      if (!m) { out.problems.push(`:61: entry not readable: ${lines[0].slice(0, 60)}`); last = null; continue; }
      const mark = m[5];
      const supplementary = lines.slice(1).join(" ").trim();
      last = {
        direction: mark === "C" || mark === "RD" ? "CREDIT" : "DEBIT",   // a reversed debit is money back in
        reversal: mark.startsWith("R"),
        amount: money(m[7]), currency: out.currency, date: ymd(m[1], m[2], m[3]), time: null,
        customerRef: m[9].trim() && m[9].trim() !== "NONREF" ? m[9].trim() : null,
        bankRef: m[10]?.trim() || null,
        rrn: null, payerVpa: null, payerName: null, narration: supplementary,
      };
      out.entries.push(last);
    } else if (tag === "86" && last) {
      last.narration = [last.narration, value.replace(/\s*\n\s*/g, " ").trim()].filter(Boolean).join(" ");
    }
  }
  for (const e of out.entries) finish(e);
  return out;
}

/** The reference, payer UPI ID and payer name an entry's own words carry. */
function finish(e: StatementEntry): void {
  // The narration is where a bank writes the payment's reference. The entry's own reference
  // fields are only asked when the narration has none: they are often 12 digits too, and are
  // the bank's or the customer's numbering, not the network's.
  e.rrn = rrnIn(e.narration) ?? rrnIn([e.bankRef ?? "", e.customerRef ?? ""].join(" "));
  e.payerVpa = e.narration.match(VPA)?.[0]?.toLowerCase() ?? null;
  // UPI narrations read UPI/CR/<rrn>/<payer name>/<bank>/<payer UPI ID>…
  const upi = e.narration.match(/UPI\/(?:CR|DR|P2A|P2M)\/\d{12}\/([^/]+)\//i);
  if (upi && !e.payerName) e.payerName = upi[1].trim() || null;
}

// ── camt.053 ─────────────────────────────────────────────────────────────────

const unescapeXml = (s: string) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Every <Tag>…</Tag> in `xml`, whatever its namespace prefix, with the attributes of its opening tag. */
function blocks(xml: string, tag: string): { attrs: string; inner: string }[] {
  const re = new RegExp(`<(?:\\w+:)?${tag}(\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => ({ attrs: m[1] ?? "", inner: m[2] }));
}
const first = (xml: string, tag: string): string | null => {
  const b = blocks(xml, tag)[0];
  return b ? unescapeXml(b.inner.trim()) : null;
};
const within = (xml: string, ...path: string[]): string | null => {
  let cur: string | null = xml;
  for (const t of path) { cur = cur == null ? null : blocks(cur, t)[0]?.inner ?? null; }
  return cur == null ? null : unescapeXml(cur.trim());
};

export function parseCamt053(xml: string): ParsedStatement {
  const out: ParsedStatement = { format: "CAMT053", account: null, currency: null, opening: null, closing: null, entries: [], problems: [] };
  const clean = xml.replace(/<!--[\s\S]*?-->/g, "");
  for (const stmt of blocks(clean, "Stmt")) {
    const acct = blocks(stmt.inner, "Acct")[0]?.inner ?? "";
    // <Id><Othr><Id>…</Id></Othr></Id> nests a tag inside one of the same name, so the account
    // is read from the inner element by its own parent, not through the outer <Id>.
    out.account ??= first(acct, "IBAN") ?? within(acct, "Othr", "Id");
    out.currency ??= first(acct, "Ccy");
    for (const bal of blocks(stmt.inner, "Bal")) {
      const code = within(bal.inner, "Tp", "CdOrPrtry", "Cd");
      const amt = Number(first(bal.inner, "Amt"));
      if (!Number.isFinite(amt)) continue;
      const signed = amt * (first(bal.inner, "CdtDbtInd") === "DBIT" ? -1 : 1);
      if (code === "OPBD" || code === "PRCD") out.opening ??= signed;
      if (code === "CLBD") out.closing = signed;
    }
    for (const n of blocks(stmt.inner, "Ntry")) {
      const amtBlock = blocks(n.inner, "Amt")[0];
      const amount = Number(amtBlock?.inner.trim());
      const ind = first(n.inner, "CdtDbtInd");
      const date = within(n.inner, "ValDt", "Dt") ?? within(n.inner, "BookgDt", "Dt") ?? within(n.inner, "BookgDt", "DtTm")?.slice(0, 10) ?? null;
      if (!amtBlock || !Number.isFinite(amount) || (ind !== "CRDT" && ind !== "DBIT") || !date) {
        out.problems.push(`entry not readable: ${n.inner.replace(/\s+/g, " ").slice(0, 80)}`);
        continue;
      }
      // Pending and information entries are not money that has moved.
      const status = within(n.inner, "Sts", "Cd") ?? first(n.inner, "Sts");
      if (status && status !== "BOOK") continue;
      const reversal = first(n.inner, "RvslInd") === "true";
      const credit = (ind === "CRDT") !== reversal;
      const details = blocks(n.inner, "NtryDtls")[0]?.inner ?? "";
      const narration = [...blocks(details, "Ustrd").map((u) => unescapeXml(u.inner.trim())), first(n.inner, "AddtlNtryInf") ?? ""]
        .filter(Boolean).join(" ");
      const e: StatementEntry = {
        direction: credit ? "CREDIT" : "DEBIT", reversal, amount,
        currency: amtBlock.attrs.match(/Ccy="([A-Z]{3})"/)?.[1] ?? out.currency,
        date, time: within(n.inner, "BookgDt", "DtTm"),
        bankRef: first(n.inner, "AcctSvcrRef"),
        customerRef: first(details, "EndToEndId") ?? first(details, "TxId"),
        rrn: null, payerVpa: null,
        payerName: credit ? within(details, "RltdPties", "Dbtr", "Nm") ?? within(details, "RltdPties", "Dbtr", "Pty", "Nm") : null,
        narration,
      };
      finish(e);
      out.entries.push(e);
    }
  }
  if (!blocks(clean, "Stmt").length) out.problems.push("no statement (Stmt) in the file");
  return out;
}

/** Read a statement of either format, or say why it is neither. */
export function parseStatement(text: string): ParsedStatement | { error: string } {
  const format = detectFormat(text);
  if (format === "MT940") return parseMt940(text);
  if (format === "CAMT053") return parseCamt053(text);
  return { error: "not an MT940 or camt.053 statement" };
}

/**
 * Do the entries account for the move from the opening to the closing balance? null when the
 * file states no balances. A statement that does not add up was truncated or misread.
 */
export function balances(s: ParsedStatement): boolean | null {
  if (s.opening == null || s.closing == null) return null;
  const net = s.entries.reduce((a, e) => a + (e.direction === "CREDIT" ? e.amount : -e.amount), 0);
  return Math.round((s.opening + net) * 100) === Math.round(s.closing * 100);
}
