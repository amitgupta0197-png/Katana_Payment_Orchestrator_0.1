"use client";

// Status Intelligence console (BRD Layer 2 + Layer 3). One screen to see the
// canonical status funnel, look up any transaction's resolved status with its full
// multi-source signal timeline, work the low-confidence review queue, and feed test
// signals into the engine. Presentation over the /api/v1/status-intel/* endpoints.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, Search, Layers, RefreshCw, Link2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { EmptyState } from "@/components/world-class/empty-state";
import { useInputDialog } from "@/components/world-class/input-dialog";
import { formatAmount, formatDateTime } from "@/lib/utils";

const money = (m: string | number | null | undefined) =>
  m == null || m === "" ? "—" : formatAmount(Number(m) / 100);

// Canonical status → badge tone.
function canonVariant(s: string): "success" | "danger" | "warning" | "brand" | "info" | "default" {
  if (s === "SUCCESS" || s === "SETTLED") return "success";
  if (s === "FAILED" || s === "REVERSED" || s === "CHARGEBACK") return "danger";
  if (s === "DUPLICATE" || s === "MISMATCH" || s === "UNDER_REVIEW" || s === "PENDING") return "warning";
  if (s === "PROCESSING") return "brand";
  return "default";
}
function confVariant(c: number): "success" | "warning" | "danger" {
  return c >= 90 ? "success" : c >= 75 ? "warning" : "danger";
}

const SOURCES = [
  "GATEWAY_API", "GATEWAY_WEBHOOK", "BANK_API", "BANK_STATEMENT", "UTR_VERIFICATION",
  "NPCI_REPORT", "SETTLEMENT_REPORT", "POOL_MONITOR", "EMAIL_PARSER", "SMS_PARSER", "TRADER_UPLOAD",
] as const;
const STATUSES = ["INITIATED", "PROCESSING", "PENDING", "SUCCESS", "FAILED", "REVERSED", "CHARGEBACK", "SETTLED", "DUPLICATE"] as const;

export default function StatusIntelligencePage() {
  const qc = useQueryClient();
  const { prompt, dialog } = useInputDialog();
  const [ref, setRef] = useState("");
  const [lookup, setLookup] = useState<string | null>(null);

  const funnel = useQuery({
    queryKey: ["si-funnel"],
    queryFn: async () => {
      const r = await fetch("/api/v1/status-intel/funnel");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { funnel: Record<string, number>; order: string[]; total: number; review_pending: number };
    },
    refetchInterval: 15000,
  });

  const review = useQuery({
    queryKey: ["si-review"],
    queryFn: async () => {
      const r = await fetch("/api/v1/status-intel/review-queue");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d.queue as any[];
    },
    refetchInterval: 15000,
  });

  const txn = useQuery({
    queryKey: ["si-txn", lookup],
    enabled: !!lookup,
    queryFn: async () => {
      const r = await fetch(`/api/v1/status-intel/transaction/${encodeURIComponent(lookup!)}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { order: any; canonical: any; signals: any[] };
    },
  });

  const ingest = useMutation({
    mutationFn: async (v: Record<string, unknown>) => {
      const r = await fetch("/api/v1/status-intel/signals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d;
    },
    onSuccess: (d) => {
      toast.success(d.matched ? `Matched ${d.order_ref} @ ${d.confidence}% (${d.method})` : `Queued for review (${d.confidence}% ${d.method})`,
        { description: d.resolution ? `Canonical: ${d.resolution.canonical_status}` : undefined });
      qc.invalidateQueries({ queryKey: ["si-funnel"] }); qc.invalidateQueries({ queryKey: ["si-review"] });
      if (lookup) qc.invalidateQueries({ queryKey: ["si-txn", lookup] });
    },
    onError: (e: Error) => toast.error("Ingest failed", { description: e.message }),
  });

  const match = useMutation({
    mutationFn: async (v: { id: string; order_ref: string }) => {
      const r = await fetch(`/api/v1/status-intel/review/${v.id}/match`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order_ref: v.order_ref }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d;
    },
    onSuccess: (d) => { toast.success(`Matched → ${d.resolution?.canonical_status}`); qc.invalidateQueries({ queryKey: ["si-review"] }); qc.invalidateQueries({ queryKey: ["si-funnel"] }); },
    onError: (e: Error) => { if (e.message !== "cancelled") toast.error("Match failed", { description: e.message }); },
  });

  async function askMatch(it: any) {
    const order_ref = await prompt({ title: `Match signal ${it.source}`, body: `${it.reported_status} • ${money(it.amount_minor)} • UTR ${it.utr ?? "—"}. Attach to which order?`, label: "Order ref", placeholder: "ORD-...", required: true, confirmLabel: "Match & resolve" });
    if (order_ref) match.mutate({ id: it.id, order_ref });
  }

  const f = funnel.data;

  return (
    <div className="space-y-6">
      {dialog}
      <PageHeader
        icon={Activity}
        title="Status Intelligence"
        description="Universal transaction status engine — resolves one canonical state from every source (gateway, bank, UTR/NPCI, settlement, parsers, pool) with confidence-scored matching."
      />

      {/* Canonical status funnel (Layer 8) */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <KpiTile label="Tracked txns" value={f?.total ?? "—"} icon={Layers} loading={funnel.isLoading} />
        {(f?.order ?? []).map((s) => (
          <KpiTile key={s} label={s.replace(/_/g, " ")} value={f?.funnel[s] ?? 0}
            variant={s === "SUCCESS" || s === "SETTLED" ? "success"
              : s === "FAILED" || s === "REVERSED" || s === "CHARGEBACK" ? "danger"
              : s === "MISMATCH" || s === "DUPLICATE" || s === "UNDER_REVIEW" ? "warning" : "default"} />
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Transaction lookup + signal timeline */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Search className="h-4 w-4" /> Transaction status lookup</CardTitle>
            <CardDescription>Resolve any order to its canonical status and inspect the multi-source signal trail.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setLookup(ref.trim() || null); }}>
              <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Order ref (e.g. ORD-…)"
                className="flex-1 rounded-md border bg-background px-3 py-2 text-sm" />
              <Button type="submit" disabled={!ref.trim()}>Look up</Button>
              {lookup && <Button type="button" variant="secondary" onClick={() => fetch(`/api/v1/status-intel/transaction/${encodeURIComponent(lookup)}`, { method: "POST" }).then(() => qc.invalidateQueries({ queryKey: ["si-txn", lookup] }))}><RefreshCw className="h-4 w-4" /></Button>}
            </form>

            {txn.isError && <p className="text-sm text-danger">{(txn.error as Error).message}</p>}
            {txn.data && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
                  <div className="font-mono text-sm">{txn.data.order.order_ref}</div>
                  <Badge variant={canonVariant(txn.data.canonical?.canonical_status ?? "")}>
                    {txn.data.canonical?.canonical_status ?? "UNRESOLVED"}
                  </Badge>
                  {txn.data.canonical && <Badge variant={confVariant(Number(txn.data.canonical.confidence))}>{Math.round(Number(txn.data.canonical.confidence))}%</Badge>}
                  <span className="text-sm text-muted-foreground">{money(txn.data.order.amount_minor)} · {txn.data.order.direction}</span>
                  <span className="ml-auto text-xs text-muted-foreground">op status: {txn.data.order.status}</span>
                </div>
                {txn.data.canonical?.reason && <p className="text-xs text-muted-foreground">Why: {txn.data.canonical.reason} · resolved from {txn.data.canonical.resolved_from} · {txn.data.canonical.signal_count} signal(s)</p>}

                <div className="space-y-2">
                  <div className="text-xs font-medium uppercase text-muted-foreground">Source signals</div>
                  {txn.data.signals.length === 0 && <p className="text-sm text-muted-foreground">No signals captured yet.</p>}
                  {txn.data.signals.map((s) => (
                    <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
                      <Badge variant="info">{s.source}</Badge>
                      <Badge variant={canonVariant(s.reported_status)}>{s.reported_status}</Badge>
                      <Badge variant={confVariant(Number(s.confidence))}>{Math.round(Number(s.confidence))}% {s.match_method}</Badge>
                      <span className="text-muted-foreground">{money(s.amount_minor)}</span>
                      {s.utr && <span className="font-mono text-xs text-muted-foreground">UTR {s.utr}</span>}
                      {s.review_status === "RESOLVED" && <Badge variant="brand">manual</Badge>}
                      <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(s.signal_time)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {lookup && !txn.data && !txn.isError && <p className="text-sm text-muted-foreground">Loading…</p>}
          </CardContent>
        </Card>

        {/* Ingest a test signal */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Link2 className="h-4 w-4" /> Ingest signal</CardTitle>
            <CardDescription>Feed a source signal; the engine matches it and resolves status.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-2" onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget as HTMLFormElement);
              const v: Record<string, unknown> = { source: fd.get("source"), reported_status: fd.get("reported_status") };
              const order_ref = String(fd.get("order_ref") || "").trim();
              const utr = String(fd.get("utr") || "").trim();
              const amount = String(fd.get("amount") || "").trim();
              if (order_ref) v.order_ref = order_ref;
              if (utr) v.utr = utr;
              if (amount) v.amount_minor = Math.round(Number(amount) * 100);
              ingest.mutate(v);
            }}>
              <select name="source" className="w-full rounded-md border bg-background px-3 py-2 text-sm">
                {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select name="reported_status" className="w-full rounded-md border bg-background px-3 py-2 text-sm">
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <input name="order_ref" placeholder="Order ref (optional)" className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
              <input name="utr" placeholder="UTR / RRN (optional)" className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
              <input name="amount" type="number" step="0.01" placeholder="Amount ₹ (optional)" className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
              <Button type="submit" className="w-full" disabled={ingest.isPending}>{ingest.isPending ? "Ingesting…" : "Ingest & resolve"}</Button>
            </form>
          </CardContent>
        </Card>
      </div>

      {/* Manual review queue (Layer 3: <75% confidence) */}
      <Card>
        <CardHeader>
          <CardTitle>Manual match review queue</CardTitle>
          <CardDescription>Signals that scored below 75% confidence or matched no order — disambiguate manually.</CardDescription>
        </CardHeader>
        <CardContent>
          {review.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {review.data && review.data.length === 0 && (
            <EmptyState title="Nothing to review" description="Every signal auto-matched at ≥75% confidence." />
          )}
          {review.data && review.data.length > 0 && (
            <div className="space-y-2">
              {review.data.map((it) => (
                <div key={it.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  <Badge variant="info">{it.source}</Badge>
                  <Badge variant={canonVariant(it.reported_status)}>{it.reported_status}</Badge>
                  <Badge variant={confVariant(Number(it.confidence))}>{Math.round(Number(it.confidence))}% {it.match_method}</Badge>
                  <span className="text-muted-foreground">{money(it.amount_minor)}</span>
                  {it.utr && <span className="font-mono text-xs text-muted-foreground">UTR {it.utr}</span>}
                  {it.customer_name && <span className="text-xs text-muted-foreground">{it.customer_name}</span>}
                  {it.order_ref && <span className="font-mono text-xs text-muted-foreground">guess {it.order_ref}</span>}
                  <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(it.signal_time)}</span>
                  <Button size="sm" variant="secondary" onClick={() => askMatch(it)}>Match</Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
