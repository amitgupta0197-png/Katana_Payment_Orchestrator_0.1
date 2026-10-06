// Keeping the support bot cheap (lib/support-bot): when a Telegram group answers (only /ask by
// default), the cheap first check's word, Telegram's model choice, the 1-hour cache on the stable
// prefix, 1-hour cache pricing, and the daily spending cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerModeOf, gateInput, parseAsk, parseGate, triggerFor } from "@/lib/support-bot/telegram-rules";
import { MODELS, chooseTelegramModel, costEstimate } from "@/lib/support-bot/router";
import { budgetState, defaultDailyBudgetInr, usdInr } from "@/lib/support-bot/budget";
import { CACHE_1H, systemBlocks } from "@/lib/support-bot/bot";
import { SUPPORT_BOT_SYSTEM, SUPPORT_BOT_TELEGRAM_SYSTEM } from "@/lib/support-bot/knowledge";

test("/ask, /ask@bot and '/ …' are asks; anything else is not", () => {
  assert.deepEqual(parseAsk("/ask why did it fail?"), { text: "why did it fail?" });
  assert.deepEqual(parseAsk("/ASK@KatanaBot is it live"), { text: "is it live" });
  assert.deepEqual(parseAsk("/ why did it fail"), { text: "why did it fail" });
  assert.deepEqual(parseAsk("/ask"), { text: "" });
  assert.equal(parseAsk("why did it fail?"), null);
  assert.equal(parseAsk("/link ABC"), null);
  assert.equal(parseAsk("/asking"), null);
});

test("only-/ask groups ignore ordinary messages; /ask on a reply and follow-ups are answered", () => {
  const m = (text: string, extra: Partial<Parameters<typeof triggerFor>[1]> = {}) => ({ text, hasPhoto: false, replyToBot: false, replied: null, ...extra });
  assert.deepEqual(triggerFor("COMMAND_ONLY", m("why did order 1234 fail?")), { kind: "IGNORE", why: "only /ask in this group" });
  assert.deepEqual(triggerFor("COMMAND_ONLY", m("/ask why did 1234 fail?")), { kind: "ASK", text: "why did 1234 fail?", usePhoto: null });
  assert.deepEqual(triggerFor("COMMAND_ONLY", m("/ask", { replied: { text: "order 1234 pending", hasPhoto: true } })),
    { kind: "ASK", text: "order 1234 pending", usePhoto: "REPLIED" });
  assert.deepEqual(triggerFor("COMMAND_ONLY", m("/ask")), { kind: "HELP" }, "/ask with nothing to answer is the help line");
  assert.deepEqual(triggerFor("COMMAND_ONLY", m("/help")), { kind: "HELP" });
  assert.deepEqual(triggerFor("COMMAND_ONLY", m("and now?", { replyToBot: true })), { kind: "ASK", text: "and now?", usePhoto: null });
  assert.deepEqual(triggerFor("EVERY_QUESTION", m("why did order 1234 fail?")), { kind: "CONSIDER" });
  assert.deepEqual(triggerFor("EVERY_QUESTION", m("/ask is it live")), { kind: "ASK", text: "is it live", usePhoto: null });
});

test("the per-group mode defaults to only /ask", () => {
  assert.equal(answerModeOf(undefined), "COMMAND_ONLY");
  assert.equal(answerModeOf("anything"), "COMMAND_ONLY");
  assert.equal(answerModeOf("EVERY_QUESTION"), "EVERY_QUESTION");
});

test("the first check's one word; anything unclear is silent", () => {
  assert.equal(parseGate("ANSWER"), "ANSWER");
  assert.equal(parseGate(" escalate."), "ESCALATE");
  assert.equal(parseGate("SILENT"), "SILENT");
  assert.equal(parseGate("I think you should answer"), "SILENT");
  assert.equal(parseGate(""), "SILENT");
  assert.match(gateInput("is it live?", ["a", "b", "c"]), /^Earlier: b\nEarlier: c\nMessage: is it live\?$/);
});

test("Telegram uses Haiku unless there is a concrete case or a screenshot; never Opus", () => {
  assert.equal(chooseTelegramModel({ question: "is it live now?", images: 0, env: {} }).tier, "LIGHT");
  assert.equal(chooseTelegramModel({ question: "what is my minimum amount?", images: 0, env: {} }).tier, "LIGHT");
  assert.equal(chooseTelegramModel({ question: "why did BBUY88-1791293656407 fail?", images: 0, env: {} }).tier, "STANDARD");
  assert.equal(chooseTelegramModel({ question: "UTR 260892978540 not showing", images: 0, env: {} }).tier, "STANDARD");
  assert.equal(chooseTelegramModel({ question: "got KP-8419E11F", images: 0, env: {} }).tier, "STANDARD");
  assert.equal(chooseTelegramModel({ question: '{"error":"x"}', images: 0, env: {} }).tier, "STANDARD");
  assert.equal(chooseTelegramModel({ question: "see this", images: 1, env: {} }).tier, "STANDARD");
});

test("the stable prefix is cached for an hour and the scope line is not", () => {
  const tg = systemBlocks({ channel: "TELEGRAM", channelNote: "NOTE", scopeText: "scope A" });
  assert.equal(tg[0].text, SUPPORT_BOT_TELEGRAM_SYSTEM);
  assert.deepEqual(tg[1].cache_control, CACHE_1H);
  assert.deepEqual(CACHE_1H, { type: "ephemeral", ttl: "1h" });
  assert.equal("cache_control" in tg[2], false);
  assert.deepEqual(systemBlocks({ channel: "TELEGRAM", channelNote: "NOTE", scopeText: "scope B" }).slice(0, 2), tg.slice(0, 2), "the cached part is identical for every group");
  const portal = systemBlocks({ scopeText: "s" });
  assert.equal(portal[0].text, SUPPORT_BOT_SYSTEM);
  assert.deepEqual(portal[0].cache_control, CACHE_1H);
  assert.ok(SUPPORT_BOT_TELEGRAM_SYSTEM.length < SUPPORT_BOT_SYSTEM.length / 3, "Telegram's instructions are much shorter");
});

test("1-hour cache writes are priced at 2x input", () => {
  // 10,000 tokens written to the 1-hour cache on Haiku: 10,000 x $2 / 1M = $0.02.
  assert.equal(costEstimate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 10_000, cacheWrite1h: 10_000 }, MODELS.LIGHT.price), 0.02);
  // The same in the 5-minute cache: 10,000 x $1.25 / 1M = $0.0125.
  assert.equal(costEstimate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 10_000 }, MODELS.LIGHT.price), 0.0125);
  // A read of the cached 10,000 tokens: 10,000 x $0.10 / 1M = $0.001.
  assert.equal(costEstimate({ input: 0, output: 0, cacheRead: 10_000, cacheWrite: 0 }, MODELS.LIGHT.price), 0.001);
});

test("the daily cap: one warning at 80%, a stop at 100%", () => {
  assert.equal(defaultDailyBudgetInr({}), 500);
  assert.equal(usdInr({}), 84);
  assert.equal(defaultDailyBudgetInr({ SUPPORT_BOT_DAILY_BUDGET_INR: "200" }), 200);
  const at = (usd: number, warned = false) => budgetState(usd, 500, warned, 84);
  assert.deepEqual([at(1).warnNow, at(1).stop], [false, false]);          // ₹84
  assert.deepEqual([at(4.77).warnNow, at(4.77).stop], [true, false]);     // ₹400.68: 80%
  assert.equal(at(4.77, true).warnNow, false, "warned once a day");
  assert.equal(at(5.96).stop, true);                                     // ₹500.64
  assert.equal(budgetState(100, 0, false, 84).stop, false, "no cap set, no stop");
});
