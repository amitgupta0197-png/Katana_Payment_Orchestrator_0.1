"use client";

// Home of the merchant portal and the banker portal (GET /api/portal/home, lib/portal-home).
// Two questions, in this order: does anything need me, and is money coming in. Then the money
// waiting to be settled, and, until every banker is live, the go-live steps with a button each.
// The detailed figures are on Reports.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowRight, BarChart3, CheckCircle2, Circle, CircleAlert, Clock, Rocket, Sparkles, Receipt, FileSpreadsheet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { istTime, rupees } from "@/lib/plain-words";
import { PortalSearchBox, usePortal } from "@/components/portal/portal-frame";
import type { HomeData } from "@/lib/portal-home";

const MUTED = "text-[color:var(--color-text-muted)]";

function greeting(now = new Date()) {
  const h = Number(now.toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function Panel({ title, children, className, action }: { title: string; children: React.ReactNode; className?: string; action?: React.ReactNode }) {
  return (
    <section className={cn("rounded-2xl border bg-[color:var(--color-surface)] p-4 shadow-sm sm:p-5", className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Attention({ items }: { items: HomeData["attention"] }) {
  if (!items.length) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border bg-[color:var(--color-surface)] px-4 py-3.5 shadow-sm">
        <CheckCircle2 className="h-5 w-5 shrink-0 text-[color:var(--color-success)]" />
        <p className="text-sm"><span className="font-medium">All good.</span> <span className={MUTED}>Nothing needs you right now.</span></p>
      </div>
    );
  }
  return (
    <section aria-labelledby="attention" className="space-y-2">
      <h2 id="attention" className="text-base font-semibold">Needs your attention</h2>
      {items.map((a) => {
        const urgent = a.level === "urgent";
        return (
          <div key={a.id} className={cn("flex flex-col gap-3 rounded-2xl border border-l-4 bg-[color:var(--color-surface)] p-4 shadow-sm sm:flex-row sm:items-center",
            urgent ? "border-l-[color:var(--color-danger)]" : "border-l-[color:var(--color-warning)]")}>
            <div className="flex min-w-0 flex-1 items-start gap-3">
              {urgent ? <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--color-danger)]" /> : <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--color-warning)]" />}
              <div className="min-w-0">
                <p className="font-medium">{a.title}</p>
                <p className={`mt-0.5 text-sm ${MUTED}`}>{a.detail}</p>
              </div>
            </div>
            {a.action && (
              <Link href={a.action.href} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-[color:var(--color-brand)] px-4 text-sm font-medium text-[color:var(--color-brand-fg)] shadow-sm hover:opacity-90">
                {a.action.label} <ArrowRight className="h-4 w-4" />
              </Link>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Stat({ label, value, sub, href, tone }: { label: string; value: string; sub?: string; href?: string; tone?: "danger" | "muted" }) {
  const body = (
    <div className={cn("h-full rounded-xl border px-3.5 py-3 transition-colors", href && "hover:border-[color:var(--color-brand)]")}>
      <div className={`text-xs ${MUTED}`}>{label}</div>
      <div className={cn("mt-1 text-xl font-semibold tabular-nums", tone === "danger" && "text-[color:var(--color-danger)]", tone === "muted" && MUTED)}>{value}</div>
      {sub && <div className={`mt-0.5 text-xs ${MUTED}`}>{sub}</div>}
    </div>
  );
  return href ? <Link href={href} className="block">{body}</Link> : body;
}

function Setup({ setup, multi }: { setup: HomeData["setup"]; multi: boolean }) {
  return (
    <Panel title="Get ready to take real payments" action={<Rocket className="h-5 w-5 text-[color:var(--color-brand)]" />}>
      <div className="space-y-5">
        {setup.map((b) => {
          const done = b.steps.filter((s) => s.done).length;
          return (
            <div key={b.code}>
              {multi && <div className="mb-1 text-sm font-medium">{b.name} <span className={MUTED}>({b.code})</span></div>}
              <div className="mb-3 flex items-center gap-3">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-[color:var(--color-surface-muted)]">
                  <div className="h-full rounded-full bg-[color:var(--color-brand)] transition-all" style={{ width: `${Math.round((done / Math.max(b.steps.length, 1)) * 100)}%` }} />
                </div>
                <span className={`text-xs ${MUTED}`}>{done} of {b.steps.length} done</span>
              </div>
              <ol className="space-y-2">
                {b.steps.map((s) => (
                  <li key={s.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    {s.done ? <CheckCircle2 className="h-5 w-5 shrink-0 text-[color:var(--color-success)]" /> : <Circle className={`h-5 w-5 shrink-0 ${MUTED}`} />}
                    <span className={cn("flex-1 text-sm", s.done && MUTED)}>{s.label}</span>
                    {!s.done && (s.action
                      ? <Link href={s.action.href} className="inline-flex min-h-9 items-center rounded-lg border px-3 text-sm font-medium hover:border-[color:var(--color-brand)] hover:text-[color:var(--color-brand)]">{s.action.label}</Link>
                      : s.katana && <span className={`text-xs ${MUTED}`}>Katana does this</span>)}
                  </li>
                ))}
              </ol>
              {b.status === "REQUESTED" && <p className="mt-3 flex items-center gap-2 text-sm"><Clock className="h-4 w-4 text-[color:var(--color-info)]" /> You asked for live mode. Katana is checking it.</p>}
              {b.status === "REJECTED" && <p className="mt-3 text-sm text-[color:var(--color-danger)]">Live mode was not approved. Open the guide or ask Katana what to change.</p>}
              {b.request && (
                <Link href={b.request.href} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl bg-[color:var(--color-brand)] px-4 text-sm font-medium text-[color:var(--color-brand-fg)] shadow-sm hover:opacity-90">
                  <Rocket className="h-4 w-4" /> {b.request.label}
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export function PortalHome() {
  const portal = usePortal();
  const base = portal?.base ?? "/banker-portal";
  const q = useQuery({
    queryKey: ["portal-home"],
    queryFn: async () => {
      const r = await fetch("/api/portal/home", { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d as HomeData;
    },
    refetchInterval: 60_000,
  });
  const d = q.data;
  const orders = `${base}/orders`;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="space-y-3">
        <div>
          <p className={`text-sm ${MUTED}`}>{new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long" })}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{greeting()}{d?.name ? `, ${d.name}` : ""}</h1>
        </div>
        <PortalSearchBox base={base} className="lg:hidden" />
      </header>

      {q.isError && <p className="rounded-xl border px-4 py-3 text-sm text-[color:var(--color-danger)]">Home could not load: {q.error.message}</p>}
      {q.isLoading && <div className="h-40 animate-pulse rounded-2xl bg-[color:var(--color-surface)]" />}

      {d && (
        <>
          <Attention items={d.attention} />

          <div className="grid gap-5 lg:grid-cols-5">
            <Panel title={d.livemode ? "Today" : "Today, test payments"} className="lg:col-span-3"
              action={<Link href={orders} className="text-sm font-medium text-[color:var(--color-brand)]">All orders</Link>}>
              <div className="mb-4">
                <div className={`text-sm ${MUTED}`}>Paid orders</div>
                <div className="text-4xl font-semibold tracking-tight tabular-nums">{rupees(d.today.paid.amount)}</div>
                <div className={`text-sm ${MUTED}`}>{d.today.paid.count} payment{d.today.paid.count === 1 ? "" : "s"}</div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Waiting" value={String(d.today.waiting)} href={orders} tone={d.today.waiting ? undefined : "muted"} />
                <Stat label="Failed" value={String(d.today.failed)} href={orders} tone={d.today.failed ? "danger" : "muted"} />
                <Stat label="Expired" value={String(d.today.expired)} href={orders} tone="muted" />
              </div>
              {(d.today.upi_received || d.today.payouts_sent.count > 0) && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {d.today.upi_received && <Stat label="Received on your UPI IDs" value={rupees(d.today.upi_received.amount)} sub={`${d.today.upi_received.count} payments`} href={`${base}/transactions`} />}
                  {d.today.payouts_sent.count > 0 && <Stat label="Payouts sent" value={rupees(d.today.payouts_sent.amount)} sub={`${d.today.payouts_sent.count} payouts`} />}
                </div>
              )}
            </Panel>

            <Panel title="Settlement" className="lg:col-span-2"
              action={<Link href={`${base}/settlements`} className="text-sm font-medium text-[color:var(--color-brand)]">Details</Link>}>
              {d.settlement ? (
                <div className="space-y-3">
                  <div>
                    <div className={`text-sm ${MUTED}`}>{base === "/merchant-portal" ? "Collected by your bankers, not settled yet" : "Collected, not settled to your merchant yet"}</div>
                    <div className="text-2xl font-semibold tabular-nums">{rupees(d.settlement.waiting)}</div>
                  </div>
                  {d.settlement.in_progress.count > 0 && (
                    <p className="text-sm">{rupees(d.settlement.in_progress.amount)} is being settled now ({d.settlement.in_progress.count}).</p>
                  )}
                  <p className={`text-sm ${MUTED}`}>
                    {d.settlement.last ? <>Last settled: {rupees(d.settlement.last.amount)} on {istTime(d.settlement.last.at)}.</> : "Nothing settled yet."}
                  </p>
                </div>
              ) : <p className={`text-sm ${MUTED}`}>No settlement to show yet.</p>}
            </Panel>
          </div>

          {d.setup.length > 0 && <Setup setup={d.setup} multi={d.bankers > 1} />}

          <nav aria-label="Shortcuts" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { href: orders, label: "Orders", icon: Receipt },
              { href: `${base}/statements`, label: "Statements", icon: FileSpreadsheet },
              { href: `${base}/reports`, label: "Reports", icon: BarChart3 },
              portal?.assistant ? { href: `${base}/assistant`, label: "Ask the assistant", icon: Sparkles } : { href: `${base}/help`, label: "Guide", icon: Sparkles },
            ].map((s) => (
              <Link key={s.href} href={s.href} className="flex min-h-14 items-center gap-3 rounded-xl border bg-[color:var(--color-surface)] px-4 text-sm font-medium shadow-sm hover:border-[color:var(--color-brand)]">
                <s.icon className="h-5 w-5 text-[color:var(--color-brand)]" /> {s.label}
              </Link>
            ))}
          </nav>
        </>
      )}
    </div>
  );
}
