// The support bot's Telegram groups, for staff (Super Admin, Admin, Support) on /support-bot.
//
//   GET  /api/support-bot/telegram
//        whether it is switched on, the groups (linked scope, status, today's count, last answer),
//        Katana staff's Telegram users, and the latest answers with their questions
//   POST /api/support-bot/telegram { action, … }
//        link_code { scope }            a one-time code; `/link CODE` in the group links it
//        pause | resume { chat_id }     one group
//        unlink { chat_id }
//        pause_all | resume_all         every group
//        add_staff { user_id, name? } | remove_staff { user_id }
//        mode { chat_id, mode }         COMMAND_ONLY (only /ask, the default) | EVERY_QUESTION
//        budget { inr }                 the daily spending cap, all channels (Super Admin)

import { NextResponse } from "next/server";
import { z } from "zod";
import { gateOrResponse } from "@/lib/scope";
import { pgError } from "@/lib/pg";
import { BOT_STAFF_PERSONAS, parseScopeKey, resolveScope } from "@/lib/support-bot/scope";
import { ANSWER_MODES, envStaffIds, telegramDailyLimit, telegramEnabled, type AnswerMode } from "@/lib/support-bot/telegram-rules";
import { budgetNow, setDailyBudgetInr } from "@/lib/support-bot/budget-store";
import {
  addStaff, createLinkCode, listGroups, listStaff, pausedAll, recentAnswers, removeStaff, setGroupMode, setGroupStatus, setPausedAll, unlinkGroup,
} from "@/lib/support-bot/telegram-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await gateOrResponse([...BOT_STAFF_PERSONAS]);
  if ("response" in g) return g.response;
  try {
    const [groups, staff, answers, paused, budget] = await Promise.all([listGroups(), listStaff(), recentAnswers(50), pausedAll(), budgetNow().catch(() => null)]);
    return NextResponse.json({
      enabled: telegramEnabled(), paused_all: paused, daily_limit: telegramDailyLimit(),
      staff_chat_set: !!process.env.TELEGRAM_SUPPORT_STAFF_CHAT?.trim(),
      groups, staff, env_staff_ids: envStaffIds().map(String), answers,
      budget: budget ? { spent_inr: budget.spentInr, cap_inr: budget.capInr, stopped: budget.stop } : null,
      can_set_budget: g.session.persona === "SUPER_ADMIN",
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link_code"), scope: z.string() }),
  z.object({ action: z.enum(["pause", "resume", "unlink"]), chat_id: z.string().regex(/^-?\d{1,20}$/) }),
  z.object({ action: z.enum(["pause_all", "resume_all"]) }),
  z.object({ action: z.literal("add_staff"), user_id: z.coerce.number().int().positive(), name: z.string().trim().max(80).optional() }),
  z.object({ action: z.literal("remove_staff"), user_id: z.coerce.number().int().positive() }),
  z.object({ action: z.literal("mode"), chat_id: z.string().regex(/^-?\d{1,20}$/), mode: z.enum(ANSWER_MODES as [AnswerMode, ...AnswerMode[]]) }),
  z.object({ action: z.literal("budget"), inr: z.coerce.number().int().min(50).max(1_000_000) }),
]);

export async function POST(req: Request) {
  const g = await gateOrResponse([...BOT_STAFF_PERSONAS]);
  if ("response" in g) return g.response;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const by = g.session.email;
  try {
    switch (body.action) {
      case "link_code": {
        const key = parseScopeKey(body.scope);
        if (!key || !(await resolveScope(key))) return NextResponse.json({ error: "banker or merchant not found" }, { status: 404 });
        return NextResponse.json(await createLinkCode(key, by));
      }
      case "pause": case "resume":
        return (await setGroupStatus(body.chat_id, body.action === "pause" ? "PAUSED" : "ACTIVE"))
          ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "group not found" }, { status: 404 });
      case "unlink":
        return (await unlinkGroup(body.chat_id, by)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "group not found" }, { status: 404 });
      case "pause_all": case "resume_all":
        await setPausedAll(body.action === "pause_all", by);
        return NextResponse.json({ ok: true });
      case "add_staff":
        await addStaff(body.user_id, body.name ?? null, by);
        return NextResponse.json({ ok: true });
      case "remove_staff":
        await removeStaff(body.user_id);
        return NextResponse.json({ ok: true });
      case "mode":
        return (await setGroupMode(body.chat_id, body.mode)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "group not found" }, { status: 404 });
      case "budget":
        if (g.session.persona !== "SUPER_ADMIN") return NextResponse.json({ error: "only a Super Admin changes the spending cap" }, { status: 403 });
        await setDailyBudgetInr(body.inr, by);
        return NextResponse.json({ ok: true });
    }
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}
