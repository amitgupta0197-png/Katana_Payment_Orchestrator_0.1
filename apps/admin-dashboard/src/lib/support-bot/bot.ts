// The support bot's turn: one question (and any screenshots) in, one plain-language answer out,
// with the lookups it made on the way (lib/support-bot/tools). Claude through the Anthropic SDK,
// a manual tool loop so every lookup is recorded for staff to inspect.
//
//   model      chosen per question by lib/support-bot/router, to keep cost down: Haiku 4.5 for
//              general questions, Sonnet 5.5 for the merchant's own case, Opus 5.5 for
//              screenshots and long pastes. One model for the whole turn.
//   fallback   server-side `fallbacks: "default"` where the model takes it: a request a safety
//              classifier declines is re-run on Anthropic's recommended model instead of
//              coming back as a refusal.
//   caching    the tool list, the instructions and the channel note are the same for every
//              request and cached for an hour (written once an hour, not once per question when
//              questions are minutes apart); the scope line after them is not cached.
//   progress   onStep is told each lookup as it starts, in plain words, so the person sees the
//              bot working; the answer itself is only shown once scrubbed.
//   history    appended to, never edited: each API message is stored as it was (thinking blocks
//              included), so the next question continues the same conversation. A turn on another
//              model than the last one ignores the earlier model's thinking blocks.
//
// The answer is scrubbed before anyone sees it: no gateway name (lib/merchant-safe), and none of
// the Salts of the bankers in scope, even though no tool ever returns one.

import Anthropic from "@anthropic-ai/sdk";
import { stripGatewayNames } from "@/lib/merchant-safe";
import { getCheckoutCreds } from "@/lib/merchant-checkout";
import { SUPPORT_BOT_SYSTEM, SUPPORT_BOT_TELEGRAM_SYSTEM, scopeContext } from "@/lib/support-bot/knowledge";
import { SUPPORT_BOT_TOOLS, TOOL_STEP_LABEL, runSupportTool } from "@/lib/support-bot/tools";
import { chooseModel, chooseTelegramModel, costEstimate, type Tier } from "@/lib/support-bot/router";

export { costEstimate };
const MAX_ROUNDS = 8;

type Msg = Anthropic.Beta.BetaMessageParam;

export interface TraceStep { tool: string; input: unknown; output: string; is_error: boolean; ms: number }

export interface BotUsage {
  model: string; tier: Tier; rounds: number; ms: number;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  /** At the chosen model's list prices; a fallback model may be priced differently. */
  cost_usd_estimate: number;
  stop_reason: string | null;
}

export interface BotTurn {
  /** Every message this turn added, in order, exactly as sent and received. */
  added: Msg[];
  reply: string;
  trace: TraceStep[];
  usage: BotUsage;
}

export class SupportBotNotConfigured extends Error {}

export type BotImageType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";
export interface BotImage { media_type: BotImageType; data: string /* base64 */ }

/** The question as the model reads it: screenshots first, then the words. */
export function questionContent(question: string, images: BotImage[] = []): Msg["content"] {
  const text = question.trim() || "Please look at this screenshot.";
  if (!images.length) return text;
  return [
    ...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.media_type, data: i.data } })),
    { type: "text" as const, text },
  ];
}

/** The reply as staff (and later the merchant) see it. Pure. */
export function scrubReply(text: string, secrets: string[]): string {
  let out = stripGatewayNames(text, "payment processor");
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[hidden]");
  return out.trim();
}

/** The cache lifetime of the stable prefix (tools + instructions + channel note). */
export const CACHE_1H = { type: "ephemeral" as const, ttl: "1h" as const };

export type BotChannel = "PORTAL" | "TELEGRAM";

/**
 * The system blocks of a request. Pure. Everything before the cache breakpoint is the same for
 * every request on a channel, so the cached prefix is byte-identical; the scope line comes after.
 */
export function systemBlocks(o: { channel?: BotChannel; scopeText: string; channelNote?: string }) {
  const base = o.channel === "TELEGRAM" ? SUPPORT_BOT_TELEGRAM_SYSTEM : SUPPORT_BOT_SYSTEM;
  const stable = o.channelNote
    ? [{ type: "text" as const, text: base }, { type: "text" as const, text: o.channelNote, cache_control: CACHE_1H }]
    : [{ type: "text" as const, text: base, cache_control: CACHE_1H }];
  return [...stable, { type: "text" as const, text: o.scopeText }];
}

const REFUSED = "I can't help with that one here. Please send it to Katana support with your merchant code and the txnid.";
const OUT_OF_ROUNDS = "I looked up several things but couldn't finish working this out. Please send it to Katana support with your merchant code and the txnid.";

export async function askSupportBot(input: {
  /** Who is asking and the bankers the lookups may read (lib/support-bot/scope). */
  scope: { name: string; accounts: { code: string; name: string }[] };
  staffTest: boolean;
  history: Msg[]; question: string; images?: BotImage[];
  onStep?: (label: string) => void;
  /** Extra instructions for the channel the answer goes to (Telegram); cached with the instructions. */
  channelNote?: string;
  /** TELEGRAM: the short chat instructions and the cheaper model choice. */
  channel?: BotChannel;
}): Promise<BotTurn> {
  if (!process.env.ANTHROPIC_API_KEY?.trim())
    throw new SupportBotNotConfigured("The support bot needs ANTHROPIC_API_KEY in .env.local");
  const client = new Anthropic();
  const started = Date.now();
  const codes = input.scope.accounts.map((a) => a.code);
  const ctx = { codes, names: Object.fromEntries(input.scope.accounts.map((a) => [a.code, a.name])) };
  const step = (label: string) => { try { input.onStep?.(label); } catch { /* the listener went away */ } };
  const messages: Msg[] = [...input.history];
  const added: Msg[] = [];
  const push = (m: Msg) => { messages.push(m); added.push(m); };
  push({ role: "user", content: questionContent(input.question, input.images) });
  step(input.images?.length ? "Reading your screenshot" : "Reading your question");

  const trace: TraceStep[] = [];
  const tally = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
  const pick = input.channel === "TELEGRAM" ? chooseTelegramModel : chooseModel;
  const choice = pick({ question: input.question, images: input.images?.length ?? 0 });
  const system = systemBlocks({ channel: input.channel, channelNote: input.channelNote, scopeText: scopeContext({ ...input.scope, staffTest: input.staffTest }) });
  let model = choice.model, stop: string | null = null, rounds = 0, reply = "";

  while (rounds < MAX_ROUNDS) {
    rounds++;
    const res = await client.beta.messages.create({
      model: choice.model,
      max_tokens: 16000,
      ...(choice.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      ...(choice.effort ? { output_config: { effort: choice.effort } } : {}),
      // The conversation so far: the 5-minute cache, after the 1-hour prefix (longer TTLs first).
      cache_control: { type: "ephemeral" },
      system,
      tools: SUPPORT_BOT_TOOLS,
      messages,
    });
    model = res.model; stop = res.stop_reason;
    tally.input += res.usage.input_tokens ?? 0;
    tally.output += res.usage.output_tokens ?? 0;
    tally.cacheRead += res.usage.cache_read_input_tokens ?? 0;
    tally.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
    tally.cacheWrite1h += res.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    push({ role: "assistant", content: res.content });

    if (res.stop_reason === "refusal") { reply = REFUSED; break; }
    if (res.stop_reason === "pause_turn") continue;
    if (res.stop_reason === "tool_use") {
      const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      // All results go back in one message, in the order the calls were made.
      for (const label of new Set(calls.map((c) => TOOL_STEP_LABEL[c.name] ?? "Looking it up"))) step(label);
      const results = await Promise.all(calls.map(async (c) => {
        const t0 = Date.now();
        const r = await runSupportTool(c.name, c.input, ctx);
        trace.push({ tool: c.name, input: c.input, output: r.text, is_error: r.isError, ms: Date.now() - t0 });
        return { type: "tool_result" as const, tool_use_id: c.id, content: r.text, ...(r.isError ? { is_error: true } : {}) };
      }));
      push({ role: "user", content: results });
      step("Writing the answer");
      continue;
    }
    reply = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n\n");
    if (res.stop_reason === "max_tokens") reply += "\n\n(The answer was cut short.)";
    break;
  }
  if (!reply) reply = OUT_OF_ROUNDS;
  // The stored conversation must stay one the API accepts when it is continued: a refusal that
  // came back empty is not kept, and a turn always ends on an assistant message (out of rounds
  // it ends on tool results), so the reply is added as one.
  const tail = added[added.length - 1];
  if (stop === "refusal" && tail?.role === "assistant" && Array.isArray(tail.content) && tail.content.length === 0) added.pop();
  if (added[added.length - 1]?.role !== "assistant") added.push({ role: "assistant", content: [{ type: "text", text: reply }] });

  const salts = await Promise.all(codes.slice(0, 50).flatMap((c) => [getCheckoutCreds(c, false), getCheckoutCreds(c, true)]))
    .then((c) => c.map((x) => x?.salt ?? "")).catch(() => []);
  return {
    added, reply: scrubReply(reply, salts), trace,
    usage: {
      model, tier: choice.tier, rounds, ms: Date.now() - started, stop_reason: stop,
      input_tokens: tally.input, output_tokens: tally.output, cache_read_tokens: tally.cacheRead, cache_write_tokens: tally.cacheWrite,
      cost_usd_estimate: costEstimate(tally, choice.price),
    },
  };
}
