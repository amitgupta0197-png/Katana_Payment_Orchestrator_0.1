"use client";

// The banker page opens on what's left before it can take live money (lib/banker-todo): one
// sentence, a progress bar and five steps that tick themselves from real state, then the live
// orders refused today. A banker that takes live payments gets a one-line summary instead.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import type { BankerTodo, TodoStep } from "@/lib/banker-todo";
import type { RefusedOrder } from "@/lib/banker-check-store";

/** Why each go-live step matters, in plain words. */
const STEP_INFO: Record<string, string> = {
  DETAILS: "The banker's company details and documents. We check them before any real money moves. Open the onboarding steps to see what is missing.",
  FLOW: "How customers pay: to the banker's UPI ID, or through a payment gateway. This decides which setup the banker needs next.",
  ACCOUNT: "Where the customer's money goes. Without it, live orders have nowhere to land and are refused.",
  TEST_PAYMENT: "One real, small payment that you make yourself. It proves money arrives and Katana hears about it.",
  GO_LIVE: "The final yes from a Super Admin. After this, the banker's live keys take real payments.",
};

const muted = "text-[color:var(--color-text-muted)]";
const subtle = "text-[color:var(--color-text-subtle)]";

type TodoData = BankerTodo & { refused: RefusedOrder[] };

export function useBankerTodo(merchantId: string) {
  return useQuery({
    queryKey: ["merchant", merchantId, "todo"],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/todo`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d as TodoData;
    },
    refetchInterval: 60_000,
  });
}

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

function StepAction({ s, onOpenTab, onAdvance }: { s: TodoStep; onOpenTab: (t: string) => void; onAdvance: () => void }) {
  if (!s.action) return null;
  const off = s.waitingFor != null;
  const variant = !s.done && !off ? "default" : "secondary";
  const label = s.action.label;
  if (s.action.href) return <Button asChild size="sm" variant={variant} disabled={off}><Link href={s.action.href}>{label}</Link></Button>;
  return (
    <Button size="sm" variant={variant} disabled={off} title={off ? `Needs step ${s.waitingFor} first` : undefined}
      onClick={() => (s.action!.kind === "advance" ? onAdvance() : onOpenTab(s.action!.tab ?? "overview"))}>
      {label}
    </Button>
  );
}

export function BankerTodoCard({ merchantId, onOpenTab, onAdvance }: { merchantId: string; onOpenTab: (t: string) => void; onAdvance: () => void }) {
  const q = useBankerTodo(merchantId);
  const d = q.data;
  if (q.isLoading) return <div className="h-24 animate-pulse rounded-xl border bg-[color:var(--color-surface)]" />;
  if (q.error || !d) return null;

  const refused = d.refused.length ? (
    <section aria-label="Orders refused today" className="rounded-xl border bg-[color:var(--color-surface)] p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">Orders we refused today
          <InfoTip label="refused orders">Live orders from this banker that Katana said no to today, and why. Fix the reason so the next order goes through.</InfoTip>
        </h2>
        <span className={`text-xs ${subtle}`}>So you hear it here first, not from the merchant</span>
      </div>
      <ul className="space-y-1.5">
        {d.refused.map((r, i) => (
          <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className={`w-12 font-mono text-xs tabular-nums ${muted}`}>{time(r.at)}</span>
            <span className="min-w-0 flex-1">
              A live order{r.amount ? ` for ₹${r.amount}` : ""} was refused: <span className="font-medium">{r.plain.text}</span>.
              {r.code && <span className={`ml-1.5 font-mono text-[11px] ${subtle}`}>{r.code}</span>}
              {r.plain.merchantSide && <span className={`ml-1.5 text-xs ${muted}`}>(the merchant's side)</span>}
            </span>
            {r.plain.fix && (r.plain.fix.href
              ? <Link className="text-xs text-[color:var(--color-brand)] hover:underline" href={r.plain.fix.href}>{r.plain.fix.label}</Link>
              : <button type="button" className="text-xs text-[color:var(--color-brand)] hover:underline" onClick={() => onOpenTab(r.plain.fix!.tab ?? "overview")}>{r.plain.fix.label}</button>)}
          </li>
        ))}
      </ul>
    </section>
  ) : null;

  if (d.live) {
    return (
      <>
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[color:var(--color-success)]/30 bg-[color:var(--color-success-muted)] px-4 py-3 text-sm">
          <CheckCircle2 className="h-4 w-4 text-[color:var(--color-success)]" aria-hidden />
          <span className="font-semibold">{d.headline}</span>
          <span className={muted}>All {d.total} steps are done.</span>
        </div>
        {refused}
      </>
    );
  }

  const pct = Math.round((d.done / d.total) * 100);
  return (
    <>
      <section aria-label="Status" className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[color:var(--color-warning)]/35 bg-[color:var(--color-warning-muted)] p-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--color-warning)]" aria-hidden />
          <div className="min-w-0">
            <div className="text-base font-semibold">{d.headline}</div>
            <div className={`text-sm ${muted}`}>{d.summary}</div>
          </div>
        </div>
        <div className="w-full max-w-[16rem] space-y-1">
          <div className={`flex justify-between text-[11px] font-medium uppercase tracking-wider ${muted}`}><span>Ready to go live</span><span className="tabular-nums">{d.done} / {d.total}</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[color:var(--color-border)]">
            <div className="h-full rounded-full bg-[color:var(--color-brand)] transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </section>

      <section aria-label="What's left" className="overflow-hidden rounded-xl border bg-[color:var(--color-surface)]">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-2 pt-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">What&apos;s left
            <InfoTip label="what's left">The steps before this banker can take real money. Each step ticks itself when it is really done.</InfoTip>
          </h2>
          <span className={`text-xs ${subtle}`}>Each step ticks itself when it's really done</span>
        </div>
        <ol>
          {d.steps.map((s) => {
            const current = !s.done && s.waitingFor == null;
            return (
              <li key={s.key} className={`flex flex-wrap items-center gap-3 border-t px-4 py-3 ${current ? "bg-[color:var(--color-brand-muted)]" : ""} ${s.waitingFor != null ? "opacity-70" : ""}`}>
                {s.done
                  ? <span aria-label="Done" className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[color:var(--color-success-muted)] text-[color:var(--color-success)]"><Check className="h-3.5 w-3.5" /></span>
                  : <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border font-mono text-xs ${current ? "border-[color:var(--color-brand)] text-[color:var(--color-brand)]" : muted}`}>{s.n}</span>}
                <div className="min-w-0 flex-1 basis-64">
                  <div className={`flex items-center gap-1.5 text-sm ${s.done ? muted : current ? "font-semibold" : "font-medium"}`}>{s.title}
                    {STEP_INFO[s.key] && <InfoTip label={s.title}>{STEP_INFO[s.key]}</InfoTip>}
                  </div>
                  <div className={`text-xs ${muted}`}>{s.detail}</div>
                  {s.waitingFor != null && <div className={`mt-0.5 text-xs ${subtle}`}>Needs step {s.waitingFor} first</div>}
                </div>
                {!s.done && <StepAction s={s} onOpenTab={onOpenTab} onAdvance={onAdvance} />}
                {s.done && s.key === "FLOW" && s.action && <Button size="sm" variant="ghost" onClick={() => onOpenTab(s.action!.tab ?? "overview")}>Change</Button>}
              </li>
            );
          })}
        </ol>
      </section>
      {refused}
    </>
  );
}
