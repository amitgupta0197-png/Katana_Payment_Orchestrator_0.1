"use client";

// Merchant readiness — every merchant with what it is onboarded for (services and pay-in flow)
// and, per banker, what is still missing. This is where a merchant that has nothing selected is
// given its choice, and where a live banker that is not set up for its merchant's choice shows.

import { Fragment, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ListChecks, ChevronDown, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { ServicesBadge } from "@/components/merchant/services";
import { FlowBadge } from "@/components/payin/flow";
import type { MerchantReadiness } from "@/components/merchant/readiness";
import { MerchantWizard } from "@/components/merchant/onboarding-wizard";
import { cn, formatDateTime } from "@/lib/utils";

interface Data { merchants: MerchantReadiness[]; counts: { merchants: number; nothing_selected: number; live_not_ready: number }; as_of: string }
type Filter = "all" | "unset" | "not_ready";

const STATE = { DONE: ["success", "Done"], MISSING: ["danger", "Needed"], OPTIONAL_MISSING: ["warning", "Optional"] } as const;
const RESULT = { PASS: ["success", "Ready"], REVIEW: ["warning", "Check"], FAIL: ["danger", "Not ready"] } as const;

export default function MerchantReadinessPage() {
  const q = useQuery({
    queryKey: ["merchant-readiness"],
    queryFn: async () => {
      const r = await fetch("/api/merchant-readiness");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as Data;
    },
  });
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<MerchantReadiness | null>(null);
  // "Set up next": walk through every merchant with nothing selected, one after another.
  const [walking, setWalking] = useState(false);

  const c = q.data?.counts;
  const unset = (m: MerchantReadiness) => m.services === "UNSET" && m.flow.flow === "UNSET";
  const notReady = (m: MerchantReadiness) => m.bankers.some((b) => b.result === "FAIL");
  const pending = (q.data?.merchants ?? []).filter((m) => unset(m) && m.id !== editing?.id);
  const startNext = () => { const m = pending[0]; if (m) { setWalking(true); setEditing(m); } else { setWalking(false); setEditing(null); } };
  const rows = (q.data?.merchants ?? []).filter((m) => filter === "all" || (filter === "unset" ? unset(m) : notReady(m)));

  return (
    <div>
      <PageHeader title="Merchant readiness" icon={ListChecks}
        description="What each merchant is onboarded for (pay-in, pay-out or both, and its pay-in flow) and what each of its bankers still needs." />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiTile label="Merchants" value={c ? c.merchants : "—"} loading={q.isLoading} />
        <KpiTile label="Nothing selected" value={c ? c.nothing_selected : "—"} sublabel="pay-ins and payouts both allowed, as before"
          loading={q.isLoading} variant={c && c.nothing_selected > 0 ? "warning" : "default"} />
        <KpiTile label="Live bankers not ready" value={c ? c.live_not_ready : "—"} sublabel="their orders on that flow are refused"
          loading={q.isLoading} variant={c && c.live_not_ready > 0 ? "danger" : "success"} />
      </div>

      {c && c.nothing_selected > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-4 rounded-2xl border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{c.nothing_selected} merchant{c.nothing_selected === 1 ? " has" : "s have"} nothing selected yet</div>
            <p className="mt-0.5 text-sm text-[color:var(--color-text-muted)]">
              They still take pay-ins and payouts as before. Set each one up: the answers are suggested from what its bankers actually did, and you confirm them.
            </p>
          </div>
          <Button onClick={startNext}>Set up the first one</Button>
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Merchants</CardTitle>
            <CardDescription>{q.data ? `As of ${formatDateTime(q.data.as_of)}` : " "}</CardDescription>
          </div>
          <div className="flex gap-1.5">
            {([["all", "All"], ["unset", "Nothing selected"], ["not_ready", "Not ready"]] as const).map(([k, label]) => (
              <Button key={k} size="sm" variant={filter === k ? "default" : "secondary"} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {q.isLoading ? <p className="text-sm text-[color:var(--color-text-muted)]">Loading…</p>
            : q.error ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>
            : rows.length === 0 ? <p className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">No merchant matches.</p>
            : (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[color:var(--color-surface-muted)] text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">
                    <tr>
                      <th className="w-8 px-2 py-2" />
                      <th className="px-3 py-2 font-medium">Merchant</th>
                      <th className="px-3 py-2 font-medium">Services</th>
                      <th className="px-3 py-2 font-medium">Pay-in flow</th>
                      <th className="px-3 py-2 text-right font-medium">Bankers</th>
                      <th className="px-3 py-2 text-right font-medium">Not ready</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => {
                      const bad = m.bankers.filter((b) => b.result === "FAIL").length;
                      const isOpen = !!open[m.id];
                      return (
                        <Fragment key={m.id}>
                          <tr className="border-t">
                            <td className="px-2 py-2">
                              <button type="button" aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} bankers of ${m.name}`}
                                disabled={!m.bankers.length} onClick={() => setOpen({ ...open, [m.id]: !isOpen })}
                                className="rounded p-1 text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)] disabled:opacity-30">
                                {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                              </button>
                            </td>
                            <td className="px-3 py-2">
                              <Link href={`/merchants/${m.id}`} className="font-medium text-[color:var(--color-brand)] hover:underline">{m.name}</Link>
                              <div className="text-xs text-[color:var(--color-text-muted)]">{m.code}{m.status !== "ACTIVE" ? ` · ${m.status}` : ""}</div>
                            </td>
                            <td className="px-3 py-2"><ServicesBadge services={m.services} /></td>
                            <td className="px-3 py-2">{m.services === "PAYOUT" ? <span className="text-[color:var(--color-text-muted)]">—</span> : <FlowBadge flow={m.flow.flow} active={m.flow.active} />}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{m.bankers.length}</td>
                            <td className={cn("px-3 py-2 text-right tabular-nums", bad > 0 && "font-medium text-[color:var(--color-danger)]")}>
                              {bad}{m.live_not_ready > 0 ? ` (${m.live_not_ready} live)` : ""}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <Button size="sm" variant={unset(m) ? "default" : "secondary"} onClick={() => { setWalking(false); setEditing(m); }}>{unset(m) ? "Set up" : "Change"}</Button>
                            </td>
                          </tr>
                          {isOpen && m.bankers.map((b) => (
                            <tr key={b.id} className="border-t bg-[color:var(--color-surface-muted)]">
                              <td />
                              <td className="px-3 py-2" colSpan={2}>
                                <Link href={`/bankers/${b.id}`} className="hover:underline">{b.name}</Link>
                                <div className="text-xs text-[color:var(--color-text-muted)]">{b.merchant_code} · {b.stage}{b.own_flow ? " · own flow" : ""}</div>
                              </td>
                              <td className="px-3 py-2">{m.services === "PAYOUT" ? null : <FlowBadge flow={b.flow.flow} active={b.flow.active} />}</td>
                              <td className="px-3 py-2" colSpan={3}>
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                                  <Badge variant={RESULT[b.result][0]}>{RESULT[b.result][1]}</Badge>
                                  {b.items.map((i) => (
                                    <span key={i.key} className="inline-flex items-center gap-1" title={i.state === "DONE" ? undefined : i.hint}>
                                      <Badge variant={STATE[i.state][0]}>{STATE[i.state][1]}</Badge>{i.label}
                                    </span>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </CardContent>
      </Card>

      {editing && (
        <MerchantWizard mode="existing" open merchant={editing}
          onOpenChange={(v) => { if (!v) { setEditing(null); setWalking(false); } }}
          remaining={walking ? pending.length : 0} onNext={startNext} />
      )}
    </div>
  );
}
