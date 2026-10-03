// The support bot (lib/support-bot): staff test it, merchants and bankers use it from their
// portals once SUPPORT_BOT_PORTALS is on (lib/support-bot/access).
//
//   GET  /api/support-bot[?scope=banker:<code>|merchant:<provider id>][&merchant_id=<banker uuid>]
//        staff: the bankers and merchants to test as, and conversations (of that scope when given)
//        portal: its own accounts and conversations
//   POST /api/support-bot { conversation_id?, text, images?: [data URL], scope? | merchant_id? }
//        ask a question; staff say which scope (`merchant_id` picks a banker), a portal user's
//        is its own. Answered as a stream of JSON lines:
//          {"type":"step","label":"Tracing the payment"}       each lookup as it starts
//          {"type":"done","conversation_id":…,"answer":{…}}    the scrubbed answer
//          {"type":"error","error":…,"code":…}
//        Anything refused before the bot starts is a plain JSON error with its status.

import { NextResponse } from "next/server";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { rows, pgError } from "@/lib/pg";
import { askSupportBot, SupportBotNotConfigured } from "@/lib/support-bot/bot";
import { createConversation, getConversation, listConversations, loadHistory, saveTurn } from "@/lib/support-bot/store";
import { parseScopeKey, resolveScope, type ScopeKey } from "@/lib/support-bot/scope";
import { botUser, canRead, dailyLimit, questionsToday } from "@/lib/support-bot/access";
import { readImages } from "@/lib/support-bot/images";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const configured = () => !!process.env.ANTHROPIC_API_KEY?.trim();

async function bankerScope(id: string): Promise<ScopeKey | null> {
  const r = await rows<{ code: string }>("merchant", `SELECT merchant_code AS code FROM merchants WHERE id = $1::uuid`, [id]).catch(() => []);
  return r[0] ? parseScopeKey(`banker:${r[0].code}`) : null;
}

/** The scope a staff request names: `scope`, or a banker by its id. */
async function staffScope(scope: unknown, merchantId: unknown): Promise<ScopeKey | null> {
  if (scope) return parseScopeKey(scope);
  if (typeof merchantId === "string" && /^[0-9a-f-]{36}$/i.test(merchantId)) return bankerScope(merchantId);
  return null;
}

export async function GET(req: Request) {
  const a = await botUser();
  if ("response" in a) return a.response;
  const u = a.user;
  const q = new URL(req.url).searchParams;
  try {
    if (!u.staff) {
      const scope = await resolveScope(u.scopeKey);
      return NextResponse.json({
        configured: configured(), staff: false,
        name: scope?.name ?? null, accounts: scope?.accounts ?? [],
        conversations: await listConversations({ scopeKey: u.scopeKey, channel: "PORTAL" }),
        questions_left_today: Math.max(dailyLimit() - await questionsToday(u.scopeKey), 0),
      });
    }
    const wanted = q.get("scope") || q.get("merchant_id");
    const key = wanted ? await staffScope(q.get("scope"), q.get("merchant_id")) : null;
    if (wanted && !key) return NextResponse.json({ error: "banker or merchant not found" }, { status: 404 });
    // Who to test as. Staff here may not be allowed the bankers or merchants list routes.
    const [bankers, merchants] = await Promise.all([
      rows<{ id: string; code: string; name: string; stage: string }>("merchant", `
        SELECT id::text, merchant_code AS code, COALESCE(NULLIF(brand_name, ''), legal_name) AS name, stage
          FROM merchants ORDER BY COALESCE(NULLIF(brand_name, ''), legal_name) LIMIT 1000`),
      rows<{ id: string; code: string; name: string }>("provider", `
        SELECT id::text, code, COALESCE(NULLIF(legal_name, ''), code) AS name FROM providers ORDER BY 3 LIMIT 1000`).catch(() => []),
    ]);
    return NextResponse.json({
      configured: configured(), staff: true, bankers, merchants,
      conversations: await listConversations({ scopeKey: key, channel: null }),
    });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }
}

const schema = z.object({
  scope: z.string().optional(),
  merchant_id: z.string().uuid().optional(),
  conversation_id: z.string().uuid().optional(),
  text: z.string().trim().max(4000).default(""),
  images: z.array(z.string()).optional(),
});

export async function POST(req: Request) {
  const a = await botUser();
  if ("response" in a) return a.response;
  const u = a.user;
  let body;
  try { body = schema.parse(await req.json()); } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  const img = readImages(body.images);
  if ("error" in img) return NextResponse.json({ error: img.error, code: "BAD_IMAGE" }, { status: 400 });
  if (!body.text && !img.images.length) return NextResponse.json({ error: "Type a question or attach a screenshot." }, { status: 400 });

  let scopeKey: ScopeKey | null;
  let conversationId = body.conversation_id ?? null;
  try {
    if (conversationId) {
      const c = await getConversation(conversationId);
      if (!canRead(u, c)) return NextResponse.json({ error: "conversation not found" }, { status: 404 });
      scopeKey = c.scope_key;
    } else {
      scopeKey = u.staff ? await staffScope(body.scope, body.merchant_id) : u.scopeKey;
      if (!scopeKey) return NextResponse.json({ error: "Choose a banker or merchant to ask as." }, { status: 400 });
    }
    if (!configured()) return NextResponse.json({ error: "The support bot needs ANTHROPIC_API_KEY in .env.local", code: "NOT_CONFIGURED" }, { status: 503 });
    if (!u.staff && await questionsToday(u.scopeKey) >= dailyLimit())
      return NextResponse.json({ error: "You have reached today's limit of questions. Please contact Katana support, or try again tomorrow.", code: "DAILY_LIMIT" }, { status: 429 });
  } catch (err) { const e = pgError(err); return NextResponse.json(e.body, { status: e.status }); }

  const scope = await resolveScope(scopeKey).catch(() => null);
  if (!scope) return NextResponse.json({ error: "banker or merchant not found" }, { status: 404 });
  if (!scope.accounts.length) return NextResponse.json({ error: "No account is linked yet, so there is nothing to look up.", code: "NO_ACCOUNT" }, { status: 409 });
  const by = u.session.email;
  const channel = u.staff ? "STAFF" : "PORTAL";
  const key = scopeKey;

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: unknown) => { try { ctrl.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch { /* closed */ } };
      try {
        const history = conversationId ? await loadHistory(conversationId) : [];
        const turn = await askSupportBot({
          scope, staffTest: u.staff, history, question: body.text, images: img.images,
          onStep: (label) => send({ type: "step", label }),
        });
        if (!conversationId) conversationId = await createConversation(key, channel, body.text, by);
        const answerId = await saveTurn(conversationId, { ...turn, question: body.text, images: img.images }, by);
        send({
          type: "done", conversation_id: conversationId,
          answer: { id: answerId, text: turn.reply, ...(u.staff ? { trace: turn.trace, usage: turn.usage } : {}) },
        });
      } catch (err) {
        send({ type: "error", ...errorBody(err) });
      } finally { ctrl.close(); }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}

function errorBody(err: unknown): { error: string; code: string } {
  if (err instanceof SupportBotNotConfigured) return { error: err.message, code: "NOT_CONFIGURED" };
  if (err instanceof Anthropic.AuthenticationError) return { error: "The Anthropic API key was refused. Check ANTHROPIC_API_KEY.", code: "BAD_KEY" };
  if (err instanceof Anthropic.RateLimitError) return { error: "Too many questions right now. Please try again in a minute.", code: "RATE_LIMITED" };
  if (err instanceof Anthropic.APIError) return { error: `The assistant could not answer (${err.status ?? "network"}). Please try again.`, code: "MODEL_ERROR" };
  const e = pgError(err);
  return { error: String((e.body as { error?: string }).error ?? "Something went wrong."), code: "ERROR" };
}
