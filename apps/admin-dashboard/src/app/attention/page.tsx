"use client";

// "Needs attention" (lib/attention): what a person should look at today, across every banker,
// worst first, each with one button to where it is fixed. STAFF ONLY.

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { ATTENTION_CATEGORIES, CATEGORY, type AttentionCategory, type AttentionView } from "@/lib/attention";

const MUTED = "text-[color:var(--color-text-muted)]";
const SEV: Record<1 | 2 | 3, "danger" | "warning" | "default"> = { 1: "danger", 2: "warning", 3: "default" };

function since(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} days`;
}

type View = AttentionView & { checkedAt: string };

export default function AttentionPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<AttentionCategory | "ALL">("ALL");
  const [fresh, setFresh] = useState(false);
  const q = useQuery({
    queryKey: ["attention", fresh],
    queryFn: async () => {
      const r = await fetch(`/api/attention${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d as View;
    },
    refetchInterval: 60_000,
  });
  const snooze = useMutation({
    mutationFn: async (key: string) => {
      const r = await fetch("/api/attention", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, hours: 24 }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d as View;
    },
    onSuccess: (d) => { qc.setQueryData(["attention", fresh], d); toast.success("Hidden for 24 hours"); },
    onError: (e: Error) => toast.error("Could not hide it", { description: e.message }),
  });

  const d = q.data;
  const items = (d?.items ?? []).filter((i) => filter === "ALL" || i.category === filter);
  const total = d ? Object.values(d.counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <div>
      <PageHeader title="Needs attention" icon={BellRing}
        description="What to look at across every banker, worst first. Each row has one button to where it is fixed."
        actions={
          <Button size="sm" variant="secondary" disabled={q.isFetching} onClick={() => { setFresh(true); void q.refetch(); }}>
            <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} /> Check again
          </Button>
        } />

      <div className="mb-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => setFilter("ALL")}
          className={`rounded-full border px-3 py-1 text-xs font-medium ${filter === "ALL" ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]" : MUTED}`}>
          All · {total}
        </button>
        {ATTENTION_CATEGORIES.map((c) => (
          <span key={c} className="inline-flex items-center gap-0.5">
            <button type="button" onClick={() => setFilter(c)} disabled={!d?.counts[c]}
              className={`rounded-full border px-3 py-1 text-xs font-medium disabled:opacity-40 ${filter === c ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]" : MUTED}`}>
              {CATEGORY[c].label} · {d?.counts[c] ?? 0}
            </button>
            <InfoTip label={CATEGORY[c].label}>{CATEGORY[c].info}</InfoTip>
          </span>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            <span>{filter === "ALL" ? "Everything open" : CATEGORY[filter].label}</span>
            <span className={`text-xs font-normal ${MUTED}`}>
              {d ? `Checked ${new Date(d.checkedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}` : ""}
              {d?.snoozed ? ` · ${d.snoozed} hidden for now` : ""}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {q.isLoading ? <p className={`py-6 text-center text-sm ${MUTED}`}>Checking every banker…</p>
            : q.error ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>
            : items.length === 0 ? <p className={`py-8 text-center text-sm ${MUTED}`}>Nothing needs attention right now.</p>
            : (
              <ul className="divide-y">
                {items.map((i) => (
                  <li key={i.key} className="flex flex-wrap items-start gap-3 py-3">
                    <Badge variant={SEV[i.severity]} className="mt-0.5 shrink-0">{i.categoryLabel}</Badge>
                    <div className="min-w-0 flex-1 basis-80">
                      <div className="text-sm font-medium">{i.title}</div>
                      <div className={`text-xs ${MUTED}`}>{i.detail}</div>
                      <div className={`mt-0.5 text-xs ${MUTED}`}>
                        <span className="font-mono">{i.bankerCode}</span>
                        {i.merchantName ? ` · ${i.merchantName}` : ""}
                        {i.since ? ` · ${since(i.since)} ago` : ""}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {i.fix && <Button asChild size="sm"><Link href={i.fix.href}>{i.fix.label}</Link></Button>}
                      <Button size="sm" variant="ghost" disabled={snooze.isPending} onClick={() => snooze.mutate(i.key)}
                        title="Hide this row for 24 hours. It comes back if the problem is still there.">
                        Hide 24h
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </CardContent>
      </Card>
    </div>
  );
}
