"use client";

// Forensic console (PayTech BRD §25/§30, FR-010). Compliance/Risk view: browse
// fraud alerts and generate a tamper-evident Evidence Pack for any order —
// order summary, status timeline, proof hashes, ledger entries, device/IP and a
// SHA-256 report hash, downloadable as JSON.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ShieldAlert, FileSearch, Download, Fingerprint, ScrollText, Receipt, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Alert {
  id: string; order_id: string | null; order_ref: string | null; merchant_id: string | null;
  alert_type: string; severity: string; detail: string | null; status: string; created_at: string;
}

const sevVariant = (s: string) =>
  s === "CRITICAL" || s === "HIGH" ? "danger" : s === "MEDIUM" ? "warning" : "info";

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Receipt; children: React.ReactNode }) {
  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Icon className="h-4 w-4" /> {title}</div>
      {children}
    </div>
  );
}

function KV({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
      {Object.entries(data).map(([k, v]) => (
        <div key={k} className="truncate">
          <span className="text-[color:var(--color-text-muted)]">{k}: </span>
          <span className="font-mono">{v === null || v === undefined || v === "" ? "—" : String(v)}</span>
        </div>
      ))}
    </div>
  );
}

export default function ForensicsPage() {
  const [ref, setRef] = useState("");
  const [pack, setPack] = useState<any>(null);

  const alerts = useQuery({
    queryKey: ["fraud-alerts"],
    queryFn: async () => {
      const r = await fetch("/api/v1/fraud-alerts");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { alerts: Alert[] };
    },
    refetchInterval: 15000,
  });

  const orders = useQuery({
    queryKey: ["forensics-orders"],
    queryFn: async () => {
      const r = await fetch("/api/v1/orders");
      const d = await r.json().catch(() => ({}));
      return (d.orders ?? []) as any[];
    },
  });

  const gen = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/v1/orders/${encodeURIComponent(id)}/evidence-pack`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d.pack;
    },
    onSuccess: (p) => { setPack(p); toast.success(`Evidence pack · ${p.section_count} sections`); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  function download() {
    if (!pack) return;
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `evidence-${pack.order?.order_ref ?? "pack"}.json`; a.click();
    URL.revokeObjectURL(url);
  }

  const list = alerts.data?.alerts ?? [];
  const open = list.filter((a) => a.status === "OPEN");
  const critical = list.filter((a) => a.severity === "CRITICAL" || a.severity === "HIGH");

  return (
    <>
      <PageHeader title="Forensics & Evidence" description="Fraud alerts and on-demand forensic evidence packs (BRD §25/§30)." icon={FileSearch} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Open alerts" value={open.length} variant={open.length > 0 ? "warning" : "default"} loading={alerts.isLoading} />
        <KpiTile label="High / critical" value={critical.length} variant={critical.length > 0 ? "danger" : "default"} loading={alerts.isLoading} />
        <KpiTile label="Total alerts" value={list.length} loading={alerts.isLoading} />
        <KpiTile label="Orders" value={orders.data?.length ?? 0} loading={orders.isLoading} />
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Generate evidence pack</CardTitle>
          <CardDescription>Enter an order ref (ORD-…) or pick a recent order. The pack is hashed (SHA-256) on generation.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input className="h-9 w-56" placeholder="ORD-XXXXXXXX" value={ref} onChange={(e) => setRef(e.target.value)} />
            <Button size="sm" onClick={() => gen.mutate(ref)} disabled={!ref || gen.isPending}><FileSearch className="h-4 w-4" /> {gen.isPending ? "Building…" : "Generate"}</Button>
            {pack && <Button size="sm" variant="secondary" onClick={download}><Download className="h-4 w-4" /> Download JSON</Button>}
          </div>
          <div className="flex flex-wrap gap-1">
            {(orders.data ?? []).slice(0, 12).map((o) => (
              <Button key={o.id} size="sm" variant="ghost" className="h-7 font-mono text-xs"
                onClick={() => { setRef(o.order_ref); gen.mutate(o.order_ref); }}>{o.order_ref}</Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {pack && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              Evidence pack · <span className="font-mono">{pack.order?.order_ref}</span>
              <Badge variant={statusVariant(pack.order?.status)}>{pack.order?.status}</Badge>
            </CardTitle>
            <CardDescription>
              report_hash <span className="font-mono">{String(pack.report_hash).slice(0, 24)}…</span> · {pack.section_count} sections · generated {formatDateTime(pack.generated_at)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {pack.order && <Section title="Order summary" icon={Receipt}><KV data={{
              merchant_id: pack.order.merchant_id, direction: pack.order.direction,
              amount: formatAmount(Number(pack.order.amount_minor), pack.order.currency),
              settlement_mode: pack.order.settlement_mode, customer: pack.order.customer_name,
              risk_score: pack.order.risk_score, risk_decision: pack.order.risk_decision,
              txn_ref: pack.order.txn_ref, utr: pack.order.utr, tx_hash: pack.order.tx_hash,
            }} /></Section>}

            {pack.device && <Section title="Device / IP" icon={Fingerprint}><KV data={pack.device} /></Section>}

            <Section title={`Status timeline (${pack.timeline?.length ?? 0})`} icon={ScrollText}>
              <div className="space-y-1">
                {(pack.timeline ?? []).map((e: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="text-[color:var(--color-text-muted)] w-36 shrink-0">{formatDateTime(e.at)}</span>
                    <Badge variant={statusVariant(e.to_status)}>{e.to_status}</Badge>
                    <span className="text-[color:var(--color-text-muted)]">{e.actor_kind}{e.actor ? ` · ${e.actor}` : ""}</span>
                    {e.reason && <span className="truncate">— {e.reason}</span>}
                  </div>
                ))}
                {(pack.timeline ?? []).length === 0 && <div className="text-xs text-[color:var(--color-text-muted)]">No events.</div>}
              </div>
            </Section>

            <Section title={`Proof files (${pack.proofs?.length ?? 0})`} icon={FileSearch}>
              {(pack.proofs ?? []).length === 0 ? <div className="text-xs text-[color:var(--color-text-muted)]">No proof uploaded.</div> :
                (pack.proofs ?? []).map((p: any, i: number) => (
                  <div key={i} className="text-xs"><span className="font-medium">{p.kind}</span> · {p.filename} · sha256 <span className="font-mono">{String(p.sha256).slice(0, 20)}…</span> · {p.size_bytes}B · {formatDateTime(p.uploaded_at)}</div>
                ))}
            </Section>

            <Section title={`Ledger entries (${pack.ledger_entries?.length ?? 0})`} icon={Receipt}>
              {(pack.ledger_entries ?? []).length === 0 ? <div className="text-xs text-[color:var(--color-text-muted)]">No ledger journal (not yet completed).</div> :
                (pack.ledger_entries ?? []).map((l: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <Badge variant={l.side === "D" ? "warning" : "success"}>{l.side}</Badge>
                    <span className="font-mono">{l.account_code}</span>
                    <span className="tabular-nums">{formatAmount(Number(l.line_amount_minor), l.currency)}</span>
                  </div>
                ))}
            </Section>

            {(pack.fraud_alerts ?? []).length > 0 && (
              <Section title={`Fraud alerts (${pack.fraud_alerts.length})`} icon={AlertTriangle}>
                {pack.fraud_alerts.map((a: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <Badge variant={sevVariant(a.severity)}>{a.severity}</Badge>
                    <span className="font-medium">{a.alert_type}</span>
                    {a.detail && <span className="truncate">— {a.detail}</span>}
                  </div>
                ))}
              </Section>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Fraud alerts ({list.length})</CardTitle>
          <CardDescription>Duplicate-UTR, velocity and operator-risk flags raised by the FIFO module.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {list.length === 0 && <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">No alerts.</div>}
          {list.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={sevVariant(a.severity)}>{a.severity}</Badge>
                <span className="font-medium">{a.alert_type}</span>
                {a.order_ref && <button className="font-mono text-xs text-[color:var(--color-brand)]" onClick={() => { setRef(a.order_ref!); gen.mutate(a.order_ref!); }}>{a.order_ref}</button>}
                {a.detail && <span className="text-xs text-[color:var(--color-text-muted)]">{a.detail}</span>}
              </div>
              <div className="flex items-center gap-2 text-xs text-[color:var(--color-text-muted)]">
                <Badge variant={a.status === "OPEN" ? "warning" : "info"}>{a.status}</Badge>
                {formatDateTime(a.created_at)}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
