// The support bot in merchants' Telegram groups. One Telegram update in, at most one answer out,
// posted without anyone approving it, so the order of checks is what keeps it safe:
//
//   1. once per update (update_id), only from a group the bot is in, never from a bot or from
//      Katana staff (support_bot_tg_staff + TELEGRAM_SUPPORT_STAFF_IDS), never while paused
//   2. /link CODE links the group to a scope (lib/support-bot/scope); an unlinked group is told
//      once that it isn't set up, and nothing more; /unlink is for staff only
//   3. considerMessage (pure): only what looks like a question, a problem or a screenshot
//   4. a burst is answered once: each message waits debounceMs, and the newest one's handler
//      takes them all (support_bot_tg_inbox)
//   5. "are you a bot?" gets the honest one-line answer; refunds, money disputes, chargebacks,
//      account changes, payout requests, complaints and anger go to a person (escalationReason)
//      without the model being asked; the group's daily cap does the same
//   6. the support assistant (lib/support-bot/bot) answers about the group's scope only, with the
//      Telegram note (TELEGRAM_NOTE); it may say SILENT or ESCALATE
//   7. the answer, already scrubbed of gateway names and Salts by the bot, is made to read like a
//      person typed it (humanizeReply), split for Telegram, and posted as a reply
//
// A person is told through TELEGRAM_SUPPORT_STAFF_CHAT (the same bot posting to Katana's staff
// chat), else through the ops alerts (lib/ops-alert).

import { askSupportBot, type BotImage } from "@/lib/support-bot/bot";
import { loadHistory, saveTurn } from "@/lib/support-bot/store";
import { resolveScope, type ScopeKey } from "@/lib/support-bot/scope";
import { raiseAlert } from "@/lib/ops-alert";
import { MAX_IMAGES } from "@/lib/support-bot/images";
import { tgMe, tgPhoto, tgSend } from "@/lib/support-bot/telegram-api";
import {
  BOT_IDENTITY_REPLY, ESCALATION_REPLY, LIMIT_REPLY, LINKED_REPLY, NOT_LINKED_REPLY, TELEGRAM_NOTE,
  askedIfBot, combineQuestion, considerMessage, debounceMs, escalationReason, humanizeReply, messageLink,
  parseCommand, readVerdict, splitForTelegram, telegramDailyLimit, telegramEnabled,
} from "@/lib/support-bot/telegram-rules";
import {
  addToInbox, answersToday, claimBurst, firstSeen, getGroup, limitNoticeToday, logAnswer, markUnlinkedNotice,
  migrateGroup, pausedAll, staffIds, todaysConversation, touchGroup, unlinkGroup, useLinkCode, type InboxRow, type TgGroup,
} from "@/lib/support-bot/telegram-store";

/** What the handler calls out to; tests replace the model and the wait. */
export interface TgDeps {
  ask: typeof askSupportBot;
  sleep: (ms: number) => Promise<void>;
}
const defaultDeps: TgDeps = { ask: askSupportBot, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/* eslint-disable @typescript-eslint/no-explicit-any */
type Update = any;

const userName = (u: any): string | null =>
  u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || (u.username ? `@${u.username}` : null) : null;

/** Handle one update. Never throws: a failure is logged and, where a merchant asked, handed to a person. */
export async function handleTelegramUpdate(update: Update, deps: Partial<TgDeps> = {}): Promise<void> {
  const d = { ...defaultDeps, ...deps };
  try {
    if (!telegramEnabled()) return;
    if (typeof update?.update_id !== "number" || !(await firstSeen(update.update_id))) return;

    // The bot was added to a group: say once that it isn't set up yet.
    const member = update.my_chat_member;
    if (member?.chat && ["group", "supergroup"].includes(member.chat.type)) {
      const g = await touchGroup(member.chat.id, member.chat.title ?? null, member.chat.username ?? null);
      if (["member", "administrator"].includes(member.new_chat_member?.status) && !g.scope_key && await markUnlinkedNotice(member.chat.id))
        await tgSend(member.chat.id, NOT_LINKED_REPLY);
      return;
    }

    const msg = update.message;
    if (!msg?.chat) return;
    const chat = msg.chat;
    const text: string = String(msg.text ?? msg.caption ?? "").trim();

    // A private message: tell the person their Telegram user id (staff add themselves with it).
    if (chat.type === "private") {
      if (parseCommand(text)?.cmd === "start" || /\bid\b/i.test(text))
        await tgSend(chat.id, `Your Telegram user id is ${msg.from?.id}. I only answer in merchant groups.`);
      return;
    }
    if (!["group", "supergroup"].includes(chat.type)) return;

    // Telegram moved the group to a supergroup: the link moves with it.
    if (msg.migrate_to_chat_id) { await migrateGroup(chat.id, msg.migrate_to_chat_id); return; }
    if (msg.migrate_from_chat_id) { await migrateGroup(msg.migrate_from_chat_id, chat.id); return; }

    const group = await touchGroup(chat.id, chat.title ?? null, chat.username ?? null);
    const [me, staff] = await Promise.all([tgMe(), staffIds()]);
    const from = msg.from ?? {};
    if (me && from.id === me.id) return;
    const isStaff = typeof from.id === "number" && staff.has(from.id);

    const cmd = parseCommand(text);
    if (cmd?.cmd === "link") {
      if (from.is_bot) return;
      const scope = await useLinkCode(cmd.code, chat.id, `telegram:${from.id}`);
      await tgSend(chat.id, scope ? LINKED_REPLY : "That link code isn't valid or has expired. The team can make a new one.", msg.message_id);
      return;
    }
    if (cmd?.cmd === "unlink") {
      if (isStaff && await unlinkGroup(chat.id, `telegram:${from.id}`)) await tgSend(chat.id, "This group is unlinked.", msg.message_id);
      return;
    }

    if (group.status === "PAUSED" || await pausedAll()) return;
    if (!group.scope_key) {
      if (!from.is_bot && !isStaff && await markUnlinkedNotice(chat.id)) await tgSend(chat.id, NOT_LINKED_REPLY);
      return;
    }
    if (cmd) return;

    const photo = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id as string : null;
    const consider = considerMessage({
      text, hasPhoto: !!photo, fromBot: !!from.is_bot, fromStaff: isStaff,
      replyToBot: !!me && msg.reply_to_message?.from?.id === me.id,
      mentionsBot: !!me?.username && text.toLowerCase().includes(`@${me.username.toLowerCase()}`),
    });
    if (!consider.answer) return;

    const inboxId = await addToInbox({ chatId: chat.id, messageId: msg.message_id, userId: from.id ?? null, userName: userName(from), text, photoFile: photo });
    if (!inboxId) return;
    await d.sleep(debounceMs());
    const burst = await claimBurst(chat.id, inboxId);
    if (!burst.length) return;
    // Paused or unlinked while it waited.
    const now = await getGroup(chat.id);
    if (!now?.scope_key || now.status === "PAUSED" || await pausedAll()) return;
    await answerBurst(now, burst, d);
  } catch (e) {
    console.error(`[support-bot:telegram] update ${update?.update_id}: ${(e as Error).stack ?? e}`);
  }
}

async function answerBurst(group: TgGroup, burst: InboxRow[], d: TgDeps): Promise<void> {
  const chatId = Number(group.chat_id);
  const last = burst[burst.length - 1];
  const replyTo = Number(last.message_id);
  const asker = last.user_id ? `telegram:${last.user_id}` : "telegram";
  const question = combineQuestion(burst.map((b) => ({ name: b.user_name, text: b.text ?? "" })));
  const base = { chatId, messageId: replyTo, scopeKey: group.scope_key, question };

  if (askedIfBot(question) && question.length < 160) {
    await tgSend(chatId, BOT_IDENTITY_REPLY, replyTo);
    await logAnswer({ ...base, outcome: "ANSWERED", reason: "RULE BOT_IDENTITY", reply: BOT_IDENTITY_REPLY });
    return;
  }

  const rule = escalationReason(question);
  if (rule) {
    await tgSend(chatId, ESCALATION_REPLY, replyTo);
    await tellStaff(group, last, question, `needs a person (${rule.toLowerCase().replace(/_/g, " ")})`);
    await logAnswer({ ...base, outcome: "ESCALATED", reason: `RULE ${rule}`, reply: ESCALATION_REPLY });
    return;
  }

  if (await answersToday(chatId) >= telegramDailyLimit()) {
    if (!(await limitNoticeToday(chatId))) {
      await tgSend(chatId, LIMIT_REPLY, replyTo);
      await tellStaff(group, last, question, `reached today's limit of ${telegramDailyLimit()} automatic answers`);
      await logAnswer({ ...base, outcome: "LIMIT", reply: LIMIT_REPLY });
    }
    return;
  }

  const scope = await resolveScope(group.scope_key as ScopeKey).catch(() => null);
  if (!scope?.accounts.length) {
    await tgSend(chatId, ESCALATION_REPLY, replyTo);
    await tellStaff(group, last, question, "the group's linked account has no bankers to look up");
    await logAnswer({ ...base, outcome: "ESCALATED", reason: "NO_ACCOUNT", reply: ESCALATION_REPLY });
    return;
  }

  const images: BotImage[] = [];
  for (const b of burst.filter((x) => x.photo_file).slice(-MAX_IMAGES)) {
    const img = await tgPhoto(b.photo_file!);
    if (img) images.push(img);
  }

  let conversationId: string | null = null;
  try {
    conversationId = await todaysConversation(group, question);
    const history = await loadHistory(conversationId);
    const turn = await d.ask({ scope, staffTest: false, history, question, images, channelNote: TELEGRAM_NOTE });
    await saveTurn(conversationId, { ...turn, question: question || "Screenshot", images }, asker);
    const v = readVerdict(turn.reply);
    const meta = { conversationId, model: turn.usage.model, cost: turn.usage.cost_usd_estimate };
    if (v.kind === "SILENT") { await logAnswer({ ...base, ...meta, outcome: "SILENT" }); return; }
    if (v.kind === "ESCALATE") {
      await tgSend(chatId, ESCALATION_REPLY, replyTo);
      await tellStaff(group, last, question, "the assistant could not answer it");
      await logAnswer({ ...base, ...meta, outcome: "ESCALATED", reason: "MODEL", reply: ESCALATION_REPLY });
      return;
    }
    const reply = humanizeReply(v.text);
    const parts = splitForTelegram(reply);
    for (const [i, p] of parts.entries()) await tgSend(chatId, p, i === 0 ? replyTo : null);
    await logAnswer({ ...base, ...meta, outcome: "ANSWERED", reply });
  } catch (e) {
    console.error(`[support-bot:telegram] answer in ${chatId}: ${(e as Error).message}`);
    await tgSend(chatId, ESCALATION_REPLY, replyTo);
    await tellStaff(group, last, question, "the assistant failed while answering");
    await logAnswer({ ...base, conversationId, outcome: "ERROR", reason: (e as Error).message.slice(0, 200), reply: ESCALATION_REPLY });
  }
}

/** Tell Katana's team a group needs a person. */
async function tellStaff(group: TgGroup, last: InboxRow, question: string, why: string): Promise<void> {
  const link = messageLink(Number(group.chat_id), Number(last.message_id), group.username);
  const body = [
    `${group.title ?? "A merchant group"} (${group.scope_key ?? "not linked"}): ${why}.`,
    `${last.user_name ?? "Someone"} wrote: ${question.slice(0, 1200) || "[a screenshot]"}`,
    link ?? `Telegram chat ${group.chat_id}, message ${last.message_id}`,
  ].join("\n\n");
  const staffChat = Number(process.env.TELEGRAM_SUPPORT_STAFF_CHAT);
  if (Number.isFinite(staffChat) && staffChat !== 0 && await tgSend(staffChat, body)) return;
  await raiseAlert({ key: `support-bot:telegram:${group.chat_id}:${last.message_id}`, severity: "WARN", title: "A merchant group needs a person", body });
}
