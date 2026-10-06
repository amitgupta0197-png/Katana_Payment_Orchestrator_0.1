// The support bot in a Telegram group (lib/support-bot/telegram), against a stand-in for Telegram's
// Bot API on localhost and with the model replaced by a stub: no call leaves the machine. A group
// is told once it isn't set up, is linked with a one-time code, gets answers only to questions,
// never answers staff, hands money and refund questions to a person without asking the model,
// answers "are you a bot?" honestly, stays silent when the model says SILENT, answers a burst
// once, ignores a repeated update, keeps its link across a supergroup move, and stops when paused.
// Run with `pnpm test:integration` (merchant 0023 applied). IT WRITES ROWS, so it only runs
// against a local database; everything it made is removed.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "http";
import { rows } from "@/lib/pg";
import type { askSupportBot } from "@/lib/support-bot/bot";
import { handleTelegramUpdate } from "@/lib/support-bot/telegram";
import { forgetTgMe } from "@/lib/support-bot/telegram-api";
import { addStaff, createLinkCode, removeStaff, setGroupStatus } from "@/lib/support-bot/telegram-store";
import { BOT_IDENTITY_REPLY, ESCALATION_REPLY, LINKED_REPLY, NOT_LINKED_REPLY } from "@/lib/support-bot/telegram-rules";

const HOST = process.env.PG_HOST ?? "localhost";
const LOCAL = ["localhost", "127.0.0.1", "::1"].includes(HOST);
const opts = { skip: LOCAL ? false : `refusing to write to a non-local database (${HOST})` };
const BANKER = process.env.TEST_BANKER ?? "M10001";
const BOT_ID = 990001, STAFF_ID = 770001, MERCHANT_ID = 550001, STAFF_CHAT = -880001;
const R = Number(String(Date.now()).slice(-6));
const CHAT = -1000000000000 - R, CHAT2 = CHAT - 1;

// ── The stand-in Telegram ─────────────────────────────────────────────────────────────────
const sent: { chat_id: number; text: string; reply_to: number | null }[] = [];
let server: Server;
before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const b = JSON.parse(raw || "{}");
      const ok = (result: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result })); };
      if (req.url?.endsWith("/getMe")) return ok({ id: BOT_ID, is_bot: true, username: "KatanaTestBot" });
      if (req.url?.endsWith("/sendMessage")) {
        sent.push({ chat_id: b.chat_id, text: b.text, reply_to: b.reply_parameters?.message_id ?? null });
        return ok({ message_id: 100000 + sent.length });
      }
      res.writeHead(404); res.end("{}");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const a = server.address();
  Object.assign(process.env, {
    SUPPORT_BOT_TELEGRAM: "1", TELEGRAM_SUPPORT_BOT_TOKEN: "itest-token", TELEGRAM_SUPPORT_WEBHOOK_SECRET: "itest-secret",
    TELEGRAM_SUPPORT_API_BASE: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`,
    TELEGRAM_SUPPORT_DEBOUNCE_MS: "0", TELEGRAM_SUPPORT_STAFF_CHAT: String(STAFF_CHAT),
  });
  forgetTgMe();
  if (LOCAL) await addStaff(STAFF_ID, "itest staff", "itest");
});
after(async () => {
  server?.close();
  if (!LOCAL) return;
  await removeStaff(STAFF_ID);
  const convs = await rows<{ id: string }>("merchant", `SELECT conversation_id::text AS id FROM support_bot_tg_answers WHERE chat_id IN ($1, $2) AND conversation_id IS NOT NULL`, [CHAT, CHAT2]);
  await rows("merchant", `DELETE FROM support_bot_tg_answers WHERE chat_id IN ($1, $2)`, [CHAT, CHAT2]);
  await rows("merchant", `DELETE FROM support_bot_tg_inbox WHERE chat_id IN ($1, $2)`, [CHAT, CHAT2]);
  await rows("merchant", `DELETE FROM support_bot_tg_groups WHERE chat_id IN ($1, $2)`, [CHAT, CHAT2]);
  await rows("merchant", `DELETE FROM support_bot_tg_link_codes WHERE used_chat IN ($1, $2) OR created_by = 'itest'`, [CHAT, CHAT2]);
  await rows("merchant", `DELETE FROM support_bot_tg_updates WHERE update_id >= $1`, [R * 1000]);
  await rows("merchant", `DELETE FROM support_bot_conversations WHERE id = ANY($1::uuid[]) OR started_by LIKE $2`,
    [convs.map((c) => c.id), `telegram:${CHAT}%`]);
  await rows("merchant", `DELETE FROM support_bot_conversations WHERE started_by IN ($1, $2)`, [`telegram:${CHAT}`, `telegram:${CHAT2}`]);
});

// ── The stub model ────────────────────────────────────────────────────────────────────────
let replies: string[] = [];
const asked: string[] = [];
const ask: typeof askSupportBot = async (input) => {
  asked.push(input.question);
  const reply = replies.shift() ?? "SILENT";
  return {
    added: [{ role: "user", content: input.question }, { role: "assistant", content: [{ type: "text", text: reply }] }],
    reply, trace: [],
    usage: { model: "stub", tier: "LIGHT", rounds: 1, ms: 1, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd_estimate: 0, stop_reason: "end_turn" },
  } as Awaited<ReturnType<typeof askSupportBot>>;
};
const deps = { ask, sleep: async () => {} };

let u = R * 1000, m = 1;
const chat = (id = CHAT) => ({ id, type: "supergroup", title: "ITEST merchant group" });
const message = (text: string, from = MERCHANT_ID, extra: Record<string, unknown> = {}, chatId = CHAT) =>
  ({ update_id: u++, message: { message_id: m++, chat: chat(chatId), from: { id: from, is_bot: false, first_name: "Juned" }, date: 0, text, ...extra } });
const take = () => sent.splice(0, sent.length);

test("a new group is told once it isn't set up, then linked with a code", opts, async () => {
  await handleTelegramUpdate({ update_id: u++, my_chat_member: { chat: chat(), new_chat_member: { status: "member" } } }, deps);
  assert.deepEqual(take().map((s) => s.text), [NOT_LINKED_REPLY]);
  await handleTelegramUpdate(message("is it live?"), deps);
  assert.equal(take().length, 0, "told only once");
  const { code } = await createLinkCode(`banker:${BANKER}`, "itest");
  await handleTelegramUpdate(message(`/link ${code}`), deps);
  assert.deepEqual(take().map((s) => s.text), [LINKED_REPLY]);
  await handleTelegramUpdate(message(`/link ${code}`), deps);
  assert.match(take()[0].text, /isn't valid/, "a code works once");
});

test("answers a question as a person would type it, in reply", opts, async () => {
  replies = ["Certainly! Yes, it's live for ₹1,000 and up. I hope this helps!"];
  const up = message("is it live now?");
  await handleTelegramUpdate(up, deps);
  const s = take();
  assert.equal(s.length, 1);
  assert.equal(s[0].text, "Yes, it's live for ₹1,000 and up.");
  assert.equal(s[0].reply_to, up.message.message_id);
  const conv = await rows<{ channel: string }>("merchant", `
    SELECT c.channel FROM support_bot_tg_groups g JOIN support_bot_conversations c ON c.id = g.conversation_id WHERE g.chat_id = $1`, [CHAT]);
  assert.equal(conv[0]?.channel, "TELEGRAM", "stored as a TELEGRAM conversation");
});

test("stays quiet on thanks, on staff, and on a repeated update", opts, async () => {
  const before = asked.length;
  await handleTelegramUpdate(message("thanks 🙏"), deps);
  await handleTelegramUpdate(message("is the callback failing?", STAFF_ID), deps);
  replies = ["It's fine."];
  const up = message("callback failing for txnid 1vcevl?");
  await handleTelegramUpdate(up, deps);
  await handleTelegramUpdate(up, deps);
  assert.equal(asked.length, before + 1, "the model was asked once");
  assert.equal(take().length, 1);
});

test("refunds and money questions go to a person without the model", opts, async () => {
  const before = asked.length;
  await handleTelegramUpdate(message("please refund the customer for txnid 1vcevl"), deps);
  assert.equal(asked.length, before, "model not asked");
  const s = take();
  assert.deepEqual(s.filter((x) => x.chat_id === CHAT).map((x) => x.text), [ESCALATION_REPLY]);
  const staff = s.find((x) => x.chat_id === STAFF_CHAT);
  assert.ok(staff && /refund/.test(staff.text) && /t\.me\/c\//.test(staff.text), "the staff chat is told, with a link");
});

test("'are you a bot?' is answered honestly; SILENT and ESCALATE from the model", opts, async () => {
  await handleTelegramUpdate(message("are you a bot?"), deps);
  assert.deepEqual(take().map((s) => s.text), [BOT_IDENTITY_REPLY]);
  replies = ["SILENT"];
  await handleTelegramUpdate(message("what is happening with the order?"), deps);
  assert.equal(take().length, 0);
  replies = ["ESCALATE"];
  await handleTelegramUpdate(message("why was the limit changed?"), deps);
  const s = take();
  assert.deepEqual(s.filter((x) => x.chat_id === CHAT).map((x) => x.text), [ESCALATION_REPLY]);
  assert.ok(s.some((x) => x.chat_id === STAFF_CHAT));
});

test("a burst of messages gets one answer", opts, async () => {
  const before = asked.length;
  replies = ["Checked it, the order is waiting for the customer to pay."];
  const first = message("order not working");
  const second = message("txnid BBUY88-1791293656407 is still pending?");
  await handleTelegramUpdate(first, { ask, sleep: async () => { await handleTelegramUpdate(second, deps); } });
  assert.equal(asked.length, before + 1, "asked once for both");
  assert.match(asked[asked.length - 1], /order not working[\s\S]*BBUY88-1791293656407/);
  const s = take();
  assert.equal(s.length, 1);
  assert.equal(s[0].reply_to, second.message.message_id, "answers the newest message");
});

test("the link survives a supergroup move; a paused group gets nothing", opts, async () => {
  await handleTelegramUpdate(message("", MERCHANT_ID, { text: undefined, migrate_to_chat_id: CHAT2 }), deps);
  replies = ["Yes."];
  await handleTelegramUpdate(message("is it live?", MERCHANT_ID, {}, CHAT2), deps);
  assert.equal(take().filter((s) => s.chat_id === CHAT2).length, 1, "the moved group is still linked");
  await setGroupStatus(CHAT2, "PAUSED");
  await handleTelegramUpdate(message("is it live?", MERCHANT_ID, {}, CHAT2), deps);
  assert.equal(take().length, 0);
});
