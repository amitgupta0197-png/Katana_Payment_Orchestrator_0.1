// The support bot's Telegram rules (lib/support-bot/telegram-rules): when it answers, when it hands
// over, the honest answer to "are you a bot?", and how a reply is made to read like a person typed it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOT_IDENTITY_REPLY, askedIfBot, combineQuestion, considerMessage, escalationReason, humanizeReply, messageLink,
  newLinkCode, parseCommand, plainForTelegram, readVerdict, splitForTelegram, telegramEnabled, TELEGRAM_NOTE,
} from "@/lib/support-bot/telegram-rules";

const facts = (text: string, o: Partial<Parameters<typeof considerMessage>[0]> = {}) =>
  ({ text, hasPhoto: false, fromBot: false, fromStaff: false, replyToBot: false, mentionsBot: false, ...o });
const answers = (text: string, o = {}) => considerMessage(facts(text, o)).answer;

test("answers questions, error pastes, ids and screenshots", () => {
  assert.equal(answers("is it live?"), true);
  assert.equal(answers('{"error":"The payment processor did not start the checkout"}'), true);
  assert.equal(answers("callback not working for BBUY88-1791288547460"), true);
  assert.equal(answers("UTR 260892978540 paid but order shows pending"), true);
  assert.equal(answers("got reference KP-8419E11F"), true);
  assert.equal(answers("minimum amount kitna hai"), true);
  assert.equal(answers("", { hasPhoto: true }), true);
  assert.equal(answers("hmm ok then", { replyToBot: true }), true);
});

test("stays quiet on greetings, thanks, emoji, chit-chat, staff, bots and commands", () => {
  for (const t of ["ok", "Thanks", "thank you 🙏", "👍", "good morning", "most welcome", "noted.", "hello", "lol nice weekend plans"])
    assert.equal(answers(t), false, t);
  assert.equal(answers("is it live?", { fromStaff: true }), false);
  assert.equal(answers("is it live?", { fromBot: true }), false);
  assert.equal(answers("/start"), false);
});

test("money, refunds, disputes, account changes, payouts, complaints and anger go to a person", () => {
  assert.equal(escalationReason("please refund the customer"), "REFUND");
  assert.equal(escalationReason("amount debited from customer but not received"), "MONEY_DISPUTE");
  assert.equal(escalationReason("where is my settlement"), "MONEY_DISPUTE");
  assert.equal(escalationReason("we got a chargeback on yesterday's order"), "CHARGEBACK");
  assert.equal(escalationReason("please change our bank account to HDFC"), "ACCOUNT_CHANGE");
  assert.equal(escalationReason("reset the salt please"), "ACCOUNT_CHANGE");
  assert.equal(escalationReason("release the payout today urgent"), "PAYOUT_REQUEST");
  assert.equal(escalationReason("this is fraud, I will go to the police"), "COMPLAINT");
  assert.equal(escalationReason("WHY IS NOTHING WORKING SINCE MORNING TODAY"), "ANGER");
  assert.equal(escalationReason("worst service!!!"), "ANGER");
  assert.equal(escalationReason("callback not received for txnid 1vcevl"), null);
  assert.equal(escalationReason("what is the minimum amount?"), null);
});

test("asked if it is a bot: answered honestly, never as a person", () => {
  for (const t of ["are you a bot?", "r u human", "is this a bot", "am I talking to a real person?", "aap bot ho?", "are you AI"])
    assert.equal(askedIfBot(t), true, t);
  assert.equal(askedIfBot("the bot callback is failing"), false);
  assert.match(BOT_IDENTITY_REPLY, /support assistant/);
  assert.doesNotMatch(BOT_IDENTITY_REPLY, /\b(I am|I'm) (a )?(human|person)\b/i);
  assert.match(TELEGRAM_NOTE, /Never claim to be a person/);
});

test("the model's control words", () => {
  assert.deepEqual(readVerdict("SILENT"), { kind: "SILENT" });
  assert.deepEqual(readVerdict(" **ESCALATE** "), { kind: "ESCALATE" });
  assert.deepEqual(readVerdict(""), { kind: "SILENT" });
  assert.deepEqual(readVerdict("Checked it, the order is paid."), { kind: "ANSWER", text: "Checked it, the order is paid." });
});

test("replies read like a person typed them", () => {
  assert.equal(humanizeReply("Certainly! The order is **paid**. I hope this helps!"), "The order is paid.");
  assert.equal(humanizeReply("Great question. Your minimum is ₹1,000. Feel free to reach out if anything else comes up."), "Your minimum is ₹1,000.");
  assert.equal(humanizeReply("As an AI, I'd be happy to help. Send ₹1,000 with a new txnid. Let me know if you have any other questions."),
    "Send ₹1,000 with a new txnid.");
  assert.equal(humanizeReply("## Status\n- paid\n- callback sent\n\nBest regards, Katana Support Team"), "Status\npaid\ncallback sent");
  assert.equal(humanizeReply("Checked it — paid — callback sent — all good"), "Checked it — paid, callback sent, all good");
  assert.equal(humanizeReply("1. Set amount 1000\n2. New txnid"), "1. Set amount 1000\n2. New txnid");
});

test("plain text and Telegram's length limit", () => {
  assert.equal(plainForTelegram("```json\n{}\n```"), "{}");
  const long = Array.from({ length: 300 }, (_, i) => `Line ${i} of a long answer.`).join("\n");
  const parts = splitForTelegram(long, 1000);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 1000));
  assert.equal(parts.join("\n").replace(/\s+/g, " "), long.replace(/\s+/g, " "));
});

test("commands, link codes, message links, bursts", () => {
  assert.deepEqual(parseCommand("/link ab12cd34"), { cmd: "link", code: "AB12CD34" });
  assert.deepEqual(parseCommand("/link@KatanaSupportBot AB12CD34"), { cmd: "link", code: "AB12CD34" });
  assert.equal(parseCommand("/link"), null);
  assert.deepEqual(parseCommand("/unlink"), { cmd: "unlink" });
  assert.equal(parseCommand("link AB12"), null);
  const c = newLinkCode();
  assert.match(c, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(messageLink(-1001234567890, 55), "https://t.me/c/1234567890/55");
  assert.equal(messageLink(-1001, 5, "acmepay"), "https://t.me/acmepay/5");
  assert.equal(messageLink(-4321, 5), null);
  assert.equal(combineQuestion([{ name: "A", text: "hi" }, { name: "A", text: "callback failing" }]), "hi\n\ncallback failing");
});

test("off unless switched on with its token and secret", () => {
  assert.equal(telegramEnabled({}), false);
  assert.equal(telegramEnabled({ SUPPORT_BOT_TELEGRAM: "1", TELEGRAM_SUPPORT_BOT_TOKEN: "t" }), false);
  assert.equal(telegramEnabled({ SUPPORT_BOT_TELEGRAM: "1", TELEGRAM_SUPPORT_BOT_TOKEN: "t", TELEGRAM_SUPPORT_WEBHOOK_SECRET: "s" }), true);
});
