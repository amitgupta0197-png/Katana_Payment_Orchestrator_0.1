// The support bot in merchants' Telegram groups (lib/support-bot/telegram): what it answers,
// what it hands to a person, and how a reply is shaped. PURE.
//
// Replies go out without anyone approving them, so the rules lean towards silence and towards a
// person: a message is answered only when it looks like a question or a problem; anything about
// money that may be owed, a refund or dispute, an account change, a complaint or anger goes to the
// staff chat without the model being asked; and the model itself may say SILENT (nothing useful to
// add) or ESCALATE (needs a person).

/** What the bot takes from a Telegram message. */
export interface TgMessageFacts {
  text: string;
  hasPhoto: boolean;
  fromBot: boolean;
  fromStaff: boolean;
  /** A reply to one of the bot's own messages. */
  replyToBot: boolean;
  /** The bot's @username appears in it. */
  mentionsBot: boolean;
}

export type Consider = { answer: true; why: string } | { answer: false; why: string };

const ACK = /^(ok(ay)?|k|kk|thanks?|thank\s*you|thx|ty|done|noted|sure|yes|no|yep|nope|great|nice|cool|good|fine|perfect|got\s*it|alright|hm+|hi+|hello|hey|good\s*(morning|afternoon|evening|night)|gm|gn|welcome|most\s*welcome|bye|👍|🙏|👌|✅)[\s.!🙏👍👌✅]*$/i;
const ONLY_EMOJI = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s.!?]+$/u;

/** Words and shapes that mean someone needs an answer. */
const NEEDS = [
  /\?/,
  /"?\berror\b"?|\bcode"?\s*:/i,
  /\b(not\s+working|doesn'?t\s+work|isn'?t\s+working|failed|failing|failure|declined|rejected|refused|stuck|pending|expired|timeout|timed\s*out)\b/i,
  /\b(callback|webhook|notify|redirect|h2h|intent|qr|upi|hash|signature|salt|key|txnid|live|test\s*mode|minimum|maximum|limit|status|settle(ment)?|payout|pay-?in|order)\b/i,
  /\b(how|what|why|when|where|which|can\s+(you|we|i)|could\s+you|please\s+(check|help|confirm|share|tell)|kindly|help|check|confirm|issue|problem)\b/i,
  /\b[A-Z0-9]{2,}[-_][A-Z0-9-_]{4,}\b/,              // order ids like BBUY88-1791…, LT-…, KTN_…
  /\b\d{12}\b/,                                     // a UTR / bank reference
  /\bKP-[0-9A-F]{8}\b/,                             // a Katana support reference
  /[{[]\s*"/,                                       // a pasted JSON body
];

/** Should this message be answered at all? Cheap, before any model is asked. */
export function considerMessage(m: TgMessageFacts): Consider {
  if (m.fromBot) return { answer: false, why: "from a bot" };
  if (m.fromStaff) return { answer: false, why: "from Katana staff" };
  const t = m.text.trim();
  if (m.hasPhoto) return { answer: true, why: "screenshot" };
  if (!t) return { answer: false, why: "no text" };
  if (t.startsWith("/")) return { answer: false, why: "a command" };
  if (ACK.test(t) || ONLY_EMOJI.test(t)) return { answer: false, why: "greeting or acknowledgement" };
  if (m.replyToBot || m.mentionsBot) return { answer: true, why: m.replyToBot ? "reply to the bot" : "mentions the bot" };
  if (t.length < 6) return { answer: false, why: "too short" };
  const hit = NEEDS.find((r) => r.test(t));
  return hit ? { answer: true, why: "looks like a question or problem" } : { answer: false, why: "chit-chat" };
}

export type EscalationReason =
  | "REFUND" | "MONEY_DISPUTE" | "CHARGEBACK" | "ACCOUNT_CHANGE" | "PAYOUT_REQUEST" | "COMPLAINT" | "ANGER";

const ESCALATE: [EscalationReason, RegExp][] = [
  ["REFUND", /\brefund(s|ed|ing)?\b|\breturn\s+(the\s+)?(money|amount|payment)\b|\breverse\s+(the\s+)?(payment|transaction)\b/i],
  ["CHARGEBACK", /\bcharge\s*-?\s*backs?\b|\bdisputes?\b/i],
  ["MONEY_DISPUTE", /\b(money|amount|payment|rs\.?|₹|inr)\b.{0,40}\b(debited|deducted|cut|taken)\b|\b(debited|deducted)\b.{0,60}\b(not\s+(received|credited|reflect)|but\b)|\bnot\s+(received|credited)\b.{0,40}\b(money|amount|payment|settlement|funds?)\b|\b(money|amount|funds?|settlement)\b.{0,40}\bnot\s+(received|credited)\b|\bwhere\s+is\s+(my|our|the)\s+(money|settlement|payment|funds?)\b/i],
  ["ACCOUNT_CHANGE", /\b(change|update|replace|add|remove|delete)\b.{0,30}\b(bank\s*account|account\s*number|ifsc|beneficiary|upi\s*id|vpa|settlement\s*account|credentials?|password|salt|secret|api\s*key|email|phone\s*number|mobile)\b|\b(new|another)\s+(bank\s*account|upi\s*id|account\s*number)\b|\b(close|deactivate|terminate|block)\s+(my|our|the)\s+account\b|\breset\s+(the\s+)?(salt|key|password|credentials?)\b/i],
  ["PAYOUT_REQUEST", /\b(withdraw(al)?|send|release|transfer|pay)\b.{0,30}\b(payout|settlement|funds?|balance|money)\b|\bsettle\s+(my|our|the)\b|\b(payout|settlement)\b.{0,30}\b(request|now|asap|urgent|today)\b/i],
  ["COMPLAINT", /\b(complaint|complain|legal|lawyer|advocate|police|court|consumer\s+forum|fir|fraud|scam|cheat(ed|ing)?|escalate|manager|ceo|founder|terminate\s+(the\s+)?(contract|agreement))\b/i],
  ["ANGER", /\b(worst|useless|pathetic|ridiculous|nonsense|disgusting|shame(ful)?|bloody|wtf|f+u+c+k+|idiots?)\b|!{3,}/i],
];

/** Questions a person must answer: the model is not asked. Null when the bot may answer. */
export function escalationReason(text: string): EscalationReason | null {
  const t = text.trim();
  if (!t) return null;
  // Shouting: most of a longer message in capitals.
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 20 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.8) return "ANGER";
  return ESCALATE.find(([, r]) => r.test(t))?.[0] ?? null;
}

export const ESCALATION_REPLY = "Got it, I've passed this to the team. Someone will reply here shortly.";
export const LIMIT_REPLY = "Passing this one to the team, someone will reply here shortly.";
export const NOT_LINKED_REPLY = "Hi, this is Katana's support assistant. This group isn't set up with me yet, so I can't look anything up. The team will link it.";
export const LINKED_REPLY = "Done, this group is set up. I'll answer questions about orders, payments, callbacks and integration here. Anything about money owed, refunds or account changes goes to the team.";

/**
 * What the model is told on Telegram, besides the support bot's own instructions: it may stay
 * silent or hand over, and these two words are the only way it does.
 */
export const TELEGRAM_NOTE = [
  "You are answering in the merchant's Telegram group. Your reply is posted there automatically, without anyone checking it.",
  "If the message needs no answer from you (chit-chat, people talking to each other, a thank you), reply with exactly: SILENT",
  "If you cannot answer it from what you looked up, if it needs a person's decision (money owed, a refund, a dispute, an account or bank change, an exception to a limit), or if you are not sure, reply with exactly: ESCALATE",
  "Never promise money, refunds, settlement or timelines. Several messages may arrive together as one question.",
  "How to write here: like someone on Katana's support team typing in a chat. 1 to 3 short sentences, usually under 40 words. Plain everyday words. No headings, no bullet or numbered lists unless you are giving steps to follow. Don't restate the question, don't sign off, no name at the end.",
  "Never write: Certainly, Great question, I hope this helps, As an AI, Feel free to, I'd be happy to, Let me know if, or similar. A light natural start is fine (Checked it, Got it).",
  "Use the merchant's own words for things (txnid, callback, link). Match their language and register: if they write Hinglish, answer in simple Hinglish.",
  "Never claim to be a person. If someone asks whether they are talking to a bot or a human, say plainly that this is Katana's support assistant and the team sees the group and can step in.",
].join("\n");

/** Did the message ask whether it is talking to a bot? Answered honestly, without the model. */
export function askedIfBot(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(are|r)\s+(you|u)\s+(a\s+|an\s+)?(bot|robot|ai|human|real\s+person|person|machine|chat\s*gpt|automated)\b/.test(t)
    || /\b(is\s+this|am\s+i\s+(talking|chatting|speaking)\s+(to|with))\s+(a\s+|an\s+)?(bot|robot|ai|human|real\s+person|machine|automated)\b/.test(t)
    || /\b(bot|ai)\s+(hai|ho)\b|\b(insaan|human)\s+(ho|hai)\b/.test(t);
}
export const BOT_IDENTITY_REPLY = "This is Katana's support assistant. The team sees everything in this group and can step in any time.";

/** Phrases that make a chat reply read as machine-written, and what they become. */
const AI_PHRASES: [RegExp, string][] = [
  [/^(certainly|absolutely|of course|sure thing|great question|good question|thanks for (reaching out|your question|asking))[!,.]?\s*/i, ""],
  [/\bas an ai( language model)?,?\s*/gi, ""],
  [/\bi'?d be (happy|glad) to help( you)?( with (that|this))?[.!,]?\s*/gi, ""],
  [/\bi'?m (happy|glad) to help[.!,]?\s*/gi, ""],
  [/\s*(i hope (this|that) helps|hope (this|that) helps)[.!]?\s*$/i, ""],
  [/\s*(please\s+)?(feel free to|don'?t hesitate to)\s+(reach out|ask|contact us|let (me|us) know)[^.!?]*[.!?]?\s*$/i, ""],
  [/\s*let (me|us) know if (you have|there'?s) any (other |more |further )?(questions?|issues?|concerns?)[^.!?]*[.!?]?\s*$/i, ""],
  [/\s*(best regards|kind regards|regards|cheers|thanks),?\s*(katana( support)?( team)?)?[.!]?\s*$/i, ""],
];

/**
 * A reply as a person on the team would type it: no Markdown, none of the stock machine phrases,
 * no list bullets unless they are steps, em dashes kept few. Pure.
 */
export function humanizeReply(text: string): string {
  let t = plainForTelegram(text);
  for (const [r, w] of AI_PHRASES) t = t.replace(r, w);
  // Bullets become plain lines; numbered steps stay.
  t = t.replace(/^\s*[-*•]\s+/gm, "");
  // At most one em dash; the rest become commas.
  let dashes = 0;
  t = t.replace(/\s*—\s*/g, (m) => (++dashes === 1 ? " — " : ", "));
  t = t.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

export type ModelVerdict = { kind: "SILENT" } | { kind: "ESCALATE" } | { kind: "ANSWER"; text: string };

/** Read the model's reply: the two control words, or an answer. */
export function readVerdict(reply: string): ModelVerdict {
  const t = reply.trim();
  const head = t.replace(/[*_`."']/g, "").trim().toUpperCase();
  if (head === "SILENT" || head.startsWith("SILENT\n")) return { kind: "SILENT" };
  if (head === "ESCALATE" || head.startsWith("ESCALATE\n") || /^ESCALATE\b/.test(head)) return { kind: "ESCALATE" };
  if (!t) return { kind: "SILENT" };
  return { kind: "ANSWER", text: t };
}

/** Plain text for Telegram: no Markdown bold, headings or code fences. */
export function plainForTelegram(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Telegram takes 4,096 characters a message; longer answers are split on paragraph, then line. */
export const TG_MAX = 4000;
export function splitForTelegram(text: string, max = TG_MAX): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const cut = Math.max(rest.lastIndexOf("\n\n", max), rest.lastIndexOf("\n", max), rest.lastIndexOf(" ", max));
    const at = cut > max / 2 ? cut : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export type TgCommand = { cmd: "link"; code: string } | { cmd: "unlink" } | { cmd: "start" } | null;

/** `/link CODE`, `/unlink`, `/start`, also as `/link@BotName CODE`. */
export function parseCommand(text: string): TgCommand {
  const m = /^\/(link|unlink|start)(?:@\w+)?(?:\s+(\S+))?\s*$/i.exec(text.trim());
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  if (cmd === "link") return m[2] ? { cmd: "link", code: m[2].toUpperCase() } : null;
  return cmd === "unlink" ? { cmd: "unlink" } : { cmd: "start" };
}

/** A new link code: 8 letters and digits people can read out (no 0/O, 1/I). */
export function newLinkCode(rand: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += A[rand(A.length)];
  return s;
}

/** A link to a message: public groups by @name, private supergroups by t.me/c. */
export function messageLink(chatId: number, messageId: number, username?: string | null): string | null {
  if (username) return `https://t.me/${username}/${messageId}`;
  const s = String(chatId);
  return s.startsWith("-100") ? `https://t.me/c/${s.slice(4)}/${messageId}` : null;
}

/** Several messages answered as one question, oldest first. */
export function combineQuestion(parts: { name: string | null; text: string }[]): string {
  const ps = parts.filter((p) => p.text.trim());
  if (ps.length <= 1) return ps[0]?.text.trim() ?? "";
  return ps.map((p) => p.text.trim()).join("\n\n");
}

/** Per group per India day. TELEGRAM_SUPPORT_DAILY_LIMIT, default 150. */
export function telegramDailyLimit(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.TELEGRAM_SUPPORT_DAILY_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 150;
}

/** How long a group's burst of messages is gathered before one answer. Default 6 s. */
export function debounceMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.TELEGRAM_SUPPORT_DEBOUNCE_MS);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 30_000) : 6_000;
}

/** Staff Telegram user ids from TELEGRAM_SUPPORT_STAFF_IDS (comma separated). */
export function envStaffIds(env: Record<string, string | undefined> = process.env): number[] {
  return (env.TELEGRAM_SUPPORT_STAFF_IDS ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

/** The Telegram bot is on only with its token, its webhook secret and SUPPORT_BOT_TELEGRAM=1. */
export function telegramEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.SUPPORT_BOT_TELEGRAM === "1" || env.SUPPORT_BOT_TELEGRAM === "true")
    && !!env.TELEGRAM_SUPPORT_BOT_TOKEN?.trim() && !!env.TELEGRAM_SUPPORT_WEBHOOK_SECRET?.trim();
}
