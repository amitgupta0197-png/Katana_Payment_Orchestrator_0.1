"use client";

// The support assistant's chat (lib/support-bot), one component for the staff test page and the
// merchant and banker portals. Staff also see what the bot looked up, which model answered and
// what it cost, and can rate answers with a note; a merchant sees the answer and a thumbs up/down.
//
// While the assistant works, the page shows each lookup as the server reports it (a stream of
// JSON lines from POST /api/support-bot), then types the answer out. Screenshots can be attached,
// pasted or dropped; they are shrunk in the browser before they are sent.

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp, Camera, Check, ChevronDown, ChevronRight, History, ImagePlus, Plus, ThumbsDown, ThumbsUp, TriangleAlert, X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface TraceStep { tool: string; input: unknown; output: string; is_error: boolean; ms: number }
interface Usage { model: string; tier?: string; rounds: number; ms: number; cost_usd_estimate: number }
export interface Conversation { id: string; scope_key: string; channel: "STAFF" | "PORTAL"; title: string | null; started_by: string; updated_at: string; questions: number }
interface Message {
  id: string; role: "user" | "assistant"; text: string; attachments: string[] | null;
  trace: TraceStep[] | null; usage: Usage | null;
  feedback: number | null; feedback_note: string | null; feedback_by: string | null; created_by: string | null; created_at: string;
  /** Screenshots shown before the server has them (data URLs). */
  local_images?: string[];
}
interface Pending { question: string; images: string[]; steps: string[] }

const MUTED = "text-[color:var(--color-text-muted)]";
const MAX_IMAGES = 3;
const PAID_BUT_FAILED = "My customer says this payment was successful, but Katana shows it as failed or expired. What happened?";

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d as T;
}

const shortTime = (v: string) => new Date(v).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** A picture shrunk to at most 1600 px on its longest side, as a JPEG data URL. */
async function shrink(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.85);
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── Pieces ────────────────────────────────────────────────────────────────────────────────

function Orb({ busy, size = 28 }: { busy?: boolean; size?: number }) {
  return <span aria-hidden className={cn("sb-orb inline-block shrink-0 rounded-full shadow-sm", busy && "sb-orb-busy")} style={{ width: size, height: size }} />;
}

/** The answer as typed, with ``` blocks shown as code. */
function AnswerText({ text, caret }: { text: string; caret?: boolean }) {
  const parts = text.split(/```[a-zA-Z]*\n?/);
  return (
    <div className="space-y-2 text-[15px] leading-relaxed">
      {parts.map((p, i) => i % 2 === 1
        ? <pre key={i} className="overflow-x-auto rounded-lg border bg-[color:var(--color-surface-muted)] px-3 py-2 font-mono text-xs">{p.replace(/\n$/, "")}</pre>
        : (p.trim() || (caret && i === parts.length - 1)) && (
          <div key={i} className={cn("whitespace-pre-wrap break-words", caret && i === parts.length - 1 && "sb-caret")}>{p.trim()}</div>
        ))}
    </div>
  );
}

/**
 * Types the answer out once, the first time it is shown. How much is shown follows the time
 * since it started, so a tab the browser slows down (in the background) catches up at once.
 */
function Typewriter({ text, onTick, onDone }: { text: string; onTick: () => void; onDone: () => void }) {
  const [n, setN] = useState(() => (reducedMotion() ? text.length : 0));
  const started = useRef<number | null>(null);
  // About 12 ms a character: a usual answer takes a second or two, a long one at most 2.4 s.
  const duration = Math.min(2400, Math.max(600, text.length * 12));
  useEffect(() => {
    if (n >= text.length) { onDone(); return; }
    started.current ??= performance.now();
    const id = window.setTimeout(() => {
      setN(Math.min(text.length, Math.ceil(((performance.now() - started.current!) / duration) * text.length)));
      onTick();
    }, 16);
    return () => window.clearTimeout(id);
  }, [n, text, duration, onTick, onDone]);
  return <AnswerText text={text.slice(0, n)} caret={n < text.length} />;
}

function Thumbs({ srcs, onOpen, align }: { srcs: string[]; onOpen: (s: string) => void; align: "start" | "end" }) {
  if (!srcs.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", align === "end" ? "justify-end" : "justify-start")}>
      {srcs.map((s) => (
        <button key={s} type="button" onClick={() => onOpen(s)} aria-label="Open screenshot"
          className="overflow-hidden rounded-xl border-2 border-white/70 shadow-sm transition-transform hover:scale-[1.02] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-brand)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={s} alt="Attached screenshot" className="h-28 w-auto max-w-[10rem] object-cover" />
        </button>
      ))}
    </div>
  );
}

function Lookups({ trace }: { trace: TraceStep[] }) {
  const [open, setOpen] = useState(false);
  if (!trace.length) return <p className={`text-xs ${MUTED}`}>Answered without looking anything up.</p>;
  return (
    <div className="text-xs">
      <button onClick={() => setOpen(!open)} className={`inline-flex items-center gap-1 ${MUTED} hover:text-[color:var(--color-brand)]`}>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Looked up {trace.map((t) => t.tool).join(", ")}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {trace.map((t, i) => (
            <div key={i} className="rounded-md border">
              <div className="flex items-center justify-between gap-2 border-b px-2 py-1">
                <span className="font-mono">{t.tool}({JSON.stringify(t.input)})</span>
                <span className={MUTED}>{t.is_error ? "failed, " : ""}{t.ms} ms</span>
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-2 py-1 font-mono text-[11px] leading-relaxed">{(() => { try { return JSON.stringify(JSON.parse(t.output), null, 2); } catch { return t.output; } })()}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const TIER_LABEL: Record<string, string> = { LIGHT: "light", STANDARD: "standard", HEAVY: "heavy" };

function Rate({ m, staff, onSaved }: { m: Message; staff: boolean; onSaved: () => void }) {
  const [note, setNote] = useState(m.feedback_note ?? "");
  const [rating, setRating] = useState<number | null>(m.feedback);
  const save = useMutation({
    mutationFn: async (r: number | null) => {
      const res = await fetch("/api/support-bot/feedback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_id: m.id, rating: r, note: note.trim() || undefined }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed");
    },
    onSuccess: () => { toast.success(staff ? "Rating saved" : "Thanks for telling us"); onSaved(); },
    onError: (e: Error) => toast.error("Couldn't save that", { description: e.message }),
  });
  const pick = (r: number) => { const next = rating === r ? null : r; setRating(next); save.mutate(next); };
  const thumb = (r: 1 | -1) => (
    <button type="button" onClick={() => pick(r)} aria-pressed={rating === r} aria-label={r === 1 ? "Helpful" : "Not helpful"}
      className={cn("rounded-full p-1.5 transition-colors hover:bg-[color:var(--color-surface-muted)]",
        rating === r ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]" : MUTED)}>
      {r === 1 ? <ThumbsUp className="h-3.5 w-3.5" /> : <ThumbsDown className="h-3.5 w-3.5" />}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <span className={cn(MUTED, "mr-1")}>{staff ? "Was this right?" : "Did this help?"}</span>
      {thumb(1)}{thumb(-1)}
      {staff && rating !== null && (
        <form className="ml-1 flex min-w-0 flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate(rating); }}>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000}
            placeholder={rating === -1 ? "What should it have said?" : "Anything to note (optional)"}
            className="h-8 min-w-0 flex-1 rounded-md border bg-[color:var(--color-surface)] px-2" />
          <Button size="sm" variant="secondary" type="submit" disabled={save.isPending}>Save note</Button>
        </form>
      )}
      {staff && m.feedback_by && <span className={cn(MUTED, "ml-1")}>rated by {m.feedback_by}</span>}
    </div>
  );
}

/** The assistant at work: each lookup lights up as it starts, then it types. */
function Working({ steps }: { steps: string[] }) {
  const shown = steps.length ? steps : ["Reading your question"];
  return (
    <div className="sb-in flex items-start gap-3" role="status" aria-live="polite">
      <Orb busy />
      <div className="min-w-0 rounded-2xl rounded-tl-md border bg-[color:var(--color-surface)] px-4 py-3 shadow-sm">
        <ol className="relative space-y-2 pl-5">
          <span aria-hidden className="absolute bottom-2 left-[5px] top-2 w-px bg-[color:var(--color-border-strong)]" />
          {shown.map((s, i) => {
            const live = i === shown.length - 1;
            return (
              <li key={`${s}-${i}`} className={cn("sb-in relative text-sm", live ? "font-medium" : MUTED)}>
                <span className={cn("absolute -left-5 top-1 flex h-[11px] w-[11px] items-center justify-center rounded-full",
                  live ? "sb-step-live bg-[color:var(--color-brand)]" : "bg-[color:var(--color-success)]")}>
                  {!live && <Check className="h-2 w-2 text-white" strokeWidth={4} />}
                </span>
                {s}{live ? "…" : ""}
              </li>
            );
          })}
        </ol>
        <div className="mt-3 flex items-center gap-1 pl-5" aria-label="Typing">
          <span className="sb-dot h-2 w-2 rounded-full bg-[color:var(--color-brand)]" />
          <span className="sb-dot h-2 w-2 rounded-full bg-[color:var(--color-brand)]" />
          <span className="sb-dot h-2 w-2 rounded-full bg-[color:var(--color-brand)]" />
        </div>
      </div>
    </div>
  );
}

// ── The chat ──────────────────────────────────────────────────────────────────────────────

export interface AssistantChatProps {
  staff: boolean;
  /** Staff: who to ask as (banker:<code> / merchant:<id>). Ignored for a portal user. */
  scope?: string | null;
  /** Shown in the greeting: the merchant or banker's name. */
  name?: string | null;
  /** Something above the thread on the staff page (who is being tested). */
  banner?: React.ReactNode;
  /** Conversations to list; staff pass those of the chosen scope. */
  conversations: Conversation[];
  configured: boolean;
  /** Called after a question is answered, to refresh the list. */
  onAnswered?: () => void;
  /** Staff: picking a conversation of another scope. */
  onPickConversation?: (c: Conversation) => void;
  /** Tailwind height of the panel; the staff page has a picker above it. */
  heightClass?: string;
  /** In a narrow panel (the floating assistant): earlier questions stay a drawer at every width. */
  compact?: boolean;
  /** A question handed over by another page (?ask=), ready to send. */
  initialText?: string;
  /** Ask for the customer's payment screenshot (the "customer says they paid" button). */
  nudgeScreenshot?: boolean;
}

export function AssistantChat({ staff, scope, name, banner, conversations, configured, onAnswered, onPickConversation, heightClass = "h-[calc(100dvh-11rem)]", initialText = "", nudgeScreenshot = false, compact = false }: AssistantChatProps) {
  const qc = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [text, setText] = useState(initialText);
  const [images, setImages] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [typingId, setTypingId] = useState<string | null>(null);
  const [typed, setTyped] = useState<Set<string>>(() => new Set());
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // A new scope (staff switching who they test as) starts a new conversation, unless the scope
  // changed because an earlier conversation of it was picked.
  const pickedScope = useRef<string | null>(null);
  useEffect(() => {
    if (pickedScope.current === scope) { pickedScope.current = null; return; }
    setConversationId(null);
  }, [scope]);

  const convo = useQuery({
    queryKey: ["support-bot", "conversation", conversationId],
    queryFn: () => getJson<{ messages: Message[] }>(`/api/support-bot/${conversationId}`),
    enabled: !!conversationId,
  });
  const messages = conversationId ? convo.data?.messages ?? [] : [];

  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(() => { toBottom(); }, [messages.length, pending?.steps.length, pending, toBottom]);

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    const room = MAX_IMAGES - images.length;
    if (room <= 0) { toast.error(`You can attach up to ${MAX_IMAGES} screenshots.`); return; }
    try {
      const out = await Promise.all(list.slice(0, room).map(shrink));
      setImages((v) => [...v, ...out].slice(0, MAX_IMAGES));
      box.current?.focus({ preventScroll: true });
    } catch { toast.error("That picture could not be opened."); }
  };

  const busy = !!pending;
  const canAsk = configured && (staff ? !!scope || !!conversationId : true);

  const ask = async (question: string, imgs: string[]) => {
    if (busy || !canAsk || (!question.trim() && !imgs.length)) return;
    setPending({ question, images: imgs, steps: [] });
    setText(""); setImages([]);
    try {
      const res = await fetch("/api/support-bot", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId ?? undefined, scope: staff ? scope ?? undefined : undefined, text: question, images: imgs }),
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", done: { conversation_id: string; answer: { id: string; text: string; trace?: TraceStep[]; usage?: Usage } } | null = null;
      for (;;) {
        const { value, done: end } = await reader.read();
        if (value) buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === "step") setPending((p) => (p && p.steps[p.steps.length - 1] !== ev.label ? { ...p, steps: [...p.steps, ev.label] } : p));
          else if (ev.type === "error") throw new Error(ev.error);
          else if (ev.type === "done") done = ev;
        }
        if (end) break;
      }
      if (!done) throw new Error("The answer was cut off. Please ask again.");
      const now = new Date().toISOString();
      const id = done.conversation_id;
      // Show the turn at once; the refetch then brings the stored copy with the same ids.
      qc.setQueryData<{ messages: Message[] }>(["support-bot", "conversation", id], (old) => ({
        messages: [
          ...(old?.messages ?? (id === conversationId ? messages : [])),
          { id: `q-${done!.answer.id}`, role: "user", text: question, attachments: null, local_images: imgs, trace: null, usage: null, feedback: null, feedback_note: null, feedback_by: null, created_by: null, created_at: now },
          { id: done!.answer.id, role: "assistant", text: done!.answer.text, attachments: null, trace: done!.answer.trace ?? null, usage: done!.answer.usage ?? null, feedback: null, feedback_note: null, feedback_by: null, created_by: null, created_at: now },
        ],
      }));
      setTypingId(done.answer.id);
      setConversationId(id);
      setPending(null);
      qc.invalidateQueries({ queryKey: ["support-bot", "conversation", id] });
      onAnswered?.();
    } catch (e) {
      setPending(null);
      setText(question); setImages(imgs);
      toast.error("The assistant couldn't answer", { description: (e as Error).message });
    }
  };

  const startNew = () => { setConversationId(null); setTypingId(null); setHistoryOpen(false); box.current?.focus({ preventScroll: true }); };
  const pickPaidButFailed = () => { setText(PAID_BUT_FAILED); fileInput.current?.click(); };

  const starters: { label: string; icon?: React.ReactNode; run: () => void }[] = [
    { label: "A customer paid, but it shows failed", icon: <Camera className="h-4 w-4" />, run: pickPaidButFailed },
    { label: "I didn't get a webhook for my last order", run: () => ask("I didn't get a webhook for my last order. Why?", []) },
    { label: "What's left before I can go live?", run: () => ask("What do I still need to do to go live?", []) },
    { label: "Why did my last payout fail?", run: () => ask("My last payout failed. Why?", []) },
  ];

  const greeting = name ? `Hi ${name}, what went wrong?` : "Hi, what went wrong?";

  return (
    <div className={cn("relative grid min-h-[30rem] grid-rows-[minmax(0,1fr)] overflow-hidden rounded-2xl border bg-[color:var(--color-surface)] shadow-sm", !compact && "lg:grid-cols-[16.5rem_minmax(0,1fr)]", compact && "min-h-0 rounded-none border-0 shadow-none", heightClass)}>
      {/* Conversations */}
      <aside className={cn(
        "absolute inset-y-0 left-0 z-20 flex w-72 min-h-0 flex-col border-r bg-[color:var(--color-surface)] p-3 transition-transform",
        !compact && "lg:static lg:w-auto lg:translate-x-0",
        historyOpen ? "translate-x-0 shadow-xl" : "-translate-x-full")}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <Button size="sm" className="flex-1" onClick={startNew} disabled={staff && !scope}><Plus className="h-4 w-4" /> New question</Button>
          <button className={cn("rounded-md p-1.5", !compact && "lg:hidden", MUTED)} onClick={() => setHistoryOpen(false)} aria-label="Close history"><X className="h-4 w-4" /></button>
        </div>
        <div className={`mb-1 px-1 text-xs ${MUTED}`}>Earlier questions</div>
        <div className="-mx-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {conversations.map((c) => (
            <button key={c.id} onClick={() => { pickedScope.current = c.scope_key; onPickConversation?.(c); setConversationId(c.id); setTypingId(null); setHistoryOpen(false); }}
              className={cn("block w-full rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-[color:var(--color-surface-muted)]",
                c.id === conversationId && "bg-[color:var(--color-brand-muted)]")}>
              <div className="truncate">{c.title || "Untitled"}</div>
              <div className={`mt-0.5 text-xs ${MUTED}`}>
                {shortTime(c.updated_at)}{staff ? `, ${c.scope_key.replace(/^merchant:(.{8}).*/, "merchant $1…").replace(/^banker:/, "")}` : ""}
                {staff && c.channel === "PORTAL" ? ", asked by the merchant" : ""}
              </div>
            </button>
          ))}
          {!conversations.length && <p className={`px-2 text-xs ${MUTED}`}>Nothing yet. Your questions will be kept here.</p>}
        </div>
      </aside>
      {historyOpen && <button aria-label="Close history" className={cn("absolute inset-0 z-10 bg-black/20", !compact && "lg:hidden")} onClick={() => setHistoryOpen(false)} />}

      {/* Thread */}
      <section
        className={cn("flex h-full min-h-0 min-w-0 flex-col overflow-hidden", dragging && "sb-drop")}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void addFiles(e.dataTransfer.files); }}>
        <header className="flex items-center gap-3 border-b px-4 py-3">
          <button className={cn("rounded-md p-1.5", !compact && "lg:hidden", MUTED)} onClick={() => setHistoryOpen(true)} aria-label="Earlier questions"><History className="h-4 w-4" /></button>
          <Orb busy={busy} size={30} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Katana assistant</div>
            <div className={`truncate text-xs ${MUTED}`}>{busy ? "Looking into it" : "Reads your orders, payments, webhooks and payouts"}</div>
          </div>
        </header>
        {banner}

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto scroll-smooth px-4 py-6">
          <div className="mx-auto flex max-w-2xl flex-col gap-5">
            {!configured && (
              <div className="flex items-start gap-2 rounded-lg border border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning-muted)] px-3 py-2 text-sm">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-warning)]" />
                <span>{staff ? <>The assistant isn&rsquo;t connected yet: add <span className="font-mono">ANTHROPIC_API_KEY</span> to the server&rsquo;s <span className="font-mono">.env.local</span> and restart.</> : "The assistant is not available right now. Please contact Katana support."}</span>
              </div>
            )}

            {!conversationId && !pending && (
              <div className="sb-in flex flex-col items-center pt-6 text-center sm:pt-12">
                <Orb size={64} />
                <h2 className="mt-5 text-2xl font-semibold tracking-tight">{greeting}</h2>
                <p className={`mt-2 max-w-md text-[15px] ${MUTED}`}>
                  Ask in your own words, or add a screenshot of the payment. I check your real orders and payments before I answer.
                </p>
                {canAsk && (
                  <div className="mt-6 grid w-full max-w-lg gap-2 sm:grid-cols-2">
                    {starters.map((s) => (
                      <button key={s.label} onClick={s.run}
                        className="flex items-center gap-2 rounded-xl border bg-[color:var(--color-surface)] px-3 py-2.5 text-left text-sm transition-colors hover:border-[color:var(--color-brand)] hover:bg-[color:var(--color-brand-muted)]">
                        {s.icon && <span className="text-[color:var(--color-brand)]">{s.icon}</span>}
                        <span>{s.label}</span>
                      </button>
                    ))}
                  </div>
                )}
                {staff && !scope && <p className={`mt-6 text-sm ${MUTED}`}>Choose a banker or merchant above to start. The assistant only sees their data.</p>}
              </div>
            )}

            {messages.map((m) => m.role === "user" ? (
              <div key={m.id} className="sb-in ml-auto flex max-w-[85%] flex-col items-end gap-2">
                <Thumbs align="end" onOpen={setLightbox} srcs={m.local_images ?? (m.attachments ?? []).map((a) => `/api/support-bot/attachments/${a}`)} />
                {m.text && <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-[color:var(--color-brand)] px-4 py-2.5 text-[15px] leading-relaxed text-[color:var(--color-brand-fg)] shadow-sm">{m.text}</div>}
                {staff && m.created_by && <div className={`text-[11px] ${MUTED}`}>{m.created_by}, {shortTime(m.created_at)}</div>}
              </div>
            ) : (
              <div key={m.id} className="sb-in flex items-start gap-3">
                <Orb />
                <div className="min-w-0 max-w-[90%] space-y-2">
                  <div className="rounded-2xl rounded-tl-md border bg-[color:var(--color-surface)] px-4 py-3 shadow-sm">
                    {m.id === typingId && !typed.has(m.id)
                      ? <Typewriter text={m.text} onTick={toBottom} onDone={() => setTyped((s) => (s.has(m.id) ? s : new Set(s).add(m.id)))} />
                      : <AnswerText text={m.text} />}
                  </div>
                  {(m.id !== typingId || typed.has(m.id)) && (
                    <div className="sb-in space-y-1.5 px-1">
                      <Rate m={m} staff={staff} onSaved={() => qc.invalidateQueries({ queryKey: ["support-bot", "conversation", conversationId] })} />
                      {staff && m.trace && <Lookups trace={m.trace} />}
                      {staff && m.usage && (
                        <div className={`text-[11px] ${MUTED}`}>
                          {(m.usage.ms / 1000).toFixed(1)} s, {m.usage.rounds} round{m.usage.rounds === 1 ? "" : "s"}, about ${m.usage.cost_usd_estimate.toFixed(3)}, {m.usage.model}{m.usage.tier ? ` (${TIER_LABEL[m.usage.tier] ?? m.usage.tier})` : ""}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {pending && (
              <>
                <div className="sb-in ml-auto flex max-w-[85%] flex-col items-end gap-2">
                  <Thumbs align="end" onOpen={setLightbox} srcs={pending.images} />
                  {pending.question && <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-[color:var(--color-brand)] px-4 py-2.5 text-[15px] leading-relaxed text-[color:var(--color-brand-fg)] shadow-sm">{pending.question}</div>}
                </div>
                <Working steps={pending.steps} />
              </>
            )}
          </div>
        </div>

        {/* Composer */}
        <form className="border-t bg-[color:var(--color-surface)] px-3 pb-3 pt-2 sm:px-4" onSubmit={(e) => { e.preventDefault(); void ask(text.trim(), images); }}>
          <div className="mx-auto max-w-2xl">
            {nudgeScreenshot && !images.length && !conversationId && !busy && canAsk && (
              <button type="button" onClick={() => fileInput.current?.click()}
                className="sb-in mb-2 flex w-full items-center gap-3 rounded-xl border border-dashed border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)] px-3 py-2.5 text-left text-sm">
                <Camera className="h-5 w-5 shrink-0 text-[color:var(--color-brand)]" />
                <span><span className="font-medium">Add the customer&rsquo;s payment screenshot</span><span className={`block text-xs ${MUTED}`}>It helps me find the payment. Then press send.</span></span>
              </button>
            )}
            {images.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {images.map((src, i) => (
                  <div key={i} className="sb-in relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt="Screenshot to send" className="h-16 w-16 rounded-lg border object-cover" />
                    <button type="button" onClick={() => setImages((v) => v.filter((_, j) => j !== i))} aria-label="Remove screenshot"
                      className="absolute -right-1.5 -top-1.5 rounded-full bg-[color:var(--color-text)] p-0.5 text-[color:var(--color-surface)] shadow">
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2 rounded-2xl border bg-[color:var(--color-surface-muted)] p-1.5 transition-colors focus-within:border-[color:var(--color-brand)]">
              <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />
              <button type="button" onClick={() => fileInput.current?.click()} disabled={!canAsk || busy || images.length >= MAX_IMAGES}
                aria-label="Add a screenshot" title="Add a screenshot"
                className={cn("rounded-xl p-2 transition-colors hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-brand)] disabled:opacity-40", MUTED)}>
                <ImagePlus className="h-5 w-5" />
              </button>
              <textarea ref={box} id="support-bot-question" value={text} rows={1} maxLength={4000}
                onChange={(e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`; }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(text.trim(), images); } }}
                onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); void addFiles(e.clipboardData.files); } }}
                placeholder={canAsk ? "Describe the problem, or add a screenshot" : staff ? "Choose who to ask as first" : "Not available"}
                disabled={!canAsk} aria-label="Your question"
                className="max-h-40 min-h-[2.5rem] min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] outline-none placeholder:text-[color:var(--color-text-subtle)]" />
              <button type="submit" disabled={!canAsk || busy || (!text.trim() && !images.length)} aria-label="Send"
                className="rounded-xl bg-[color:var(--color-brand)] p-2 text-[color:var(--color-brand-fg)] shadow-sm transition-opacity disabled:opacity-35">
                <ArrowUp className="h-5 w-5" />
              </button>
            </div>
            <p className={`mt-1.5 px-1 text-[11px] ${MUTED}`}>
              The assistant can make mistakes. It never changes anything on your account. A screenshot alone does not mark a payment as paid.
            </p>
          </div>
        </form>
      </section>

      {lightbox && (
        <button className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-6" onClick={() => setLightbox(null)} aria-label="Close screenshot">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="Screenshot" className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </button>
      )}
    </div>
  );
}
