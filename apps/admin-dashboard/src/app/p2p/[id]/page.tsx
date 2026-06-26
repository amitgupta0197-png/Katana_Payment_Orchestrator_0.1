"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, ChevronLeft, Plus, Link2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Trader { id: string; trader_code: string; name: string; kind: string; status: string; risk_tier: string; per_txn_max: number; daily_amount_max: number; daily_count_max: number; vpa_mode: string; created_at: string }
interface Vpa { id: string; vpa: string; label?: string; status: string; is_primary: boolean }
interface Coll { id: string; vpa?: string; amount: number; utr?: string; status: string; match_result?: string; created_at: string }

export default function P2PTraderDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const [vpa, setVpa] = useState("");
  const [coll, setColl] = useState({ amount: "", utr: "", vpa: "", expected_amount: "" });

  const q = useQuery({
    queryKey: ["p2p:trader", id],
    queryFn: async () => (await fetch(`/api/p2p/traders/${id}`).then((r) => r.json())) as { trader: Trader; vpas: Vpa[]; users: any[]; collections: Coll[] },
  });

  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const r = await fetch(`/api/p2p/traders/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["p2p:trader", id] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const collect = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/p2p/traders/${id}/collect`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: coll.amount, utr: coll.utr, vpa: coll.vpa || undefined, expected_amount: coll.expected_amount || undefined }),
      });
      const d = await r.json();
      return { ok: r.ok, d };
    },
    onSuccess: ({ ok, d }) => {
      if (ok) toast.success(`${d.match_result} · ${d.status}`);
      else toast.error(`${d.match_result ?? "Rejected"}`, { description: d.error ?? "" });
      setColl({ amount: "", utr: "", vpa: "", expected_amount: "" });
      qc.invalidateQueries({ queryKey: ["p2p:trader", id] });
    },
  });

  if (q.isLoading) return <Card><CardContent className="py-8 text-center text-sm">Loading…</CardContent></Card>;
  const t = q.data?.trader;
  if (!t) return <Card><CardContent className="py-8 text-center"><Link className="text-[color:var(--color-brand)] hover:underline" href="/p2p">← back to traders</Link></CardContent></Card>;
  const vpas = q.data?.vpas ?? []; const collections = q.data?.collections ?? [];

  const vCols: Column<Vpa>[] = [
    { key: "vpa", header: "VPA", render: (r) => <span className="font-mono text-xs">{r.vpa}{r.is_primary ? " ★" : ""}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={r.status === "ACTIVE" ? "success" : r.status === "FAILED" ? "danger" : "default"}>{r.status}</Badge> },
    { key: "act", header: "", render: (r) => (
      <div className="flex gap-1">
        {r.status !== "ACTIVE" && <Button size="sm" variant="ghost" onClick={() => patch.mutate({ action: "set_active_vpa", vpa: r.vpa })}>Activate</Button>}
        <Button size="sm" variant="ghost" onClick={() => patch.mutate({ action: "remove_vpa", vpa: r.vpa })}>Remove</Button>
      </div>
    ) },
  ];
  const cCols: Column<Coll>[] = [
    { key: "created_at", header: "When", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount)}</span> },
    { key: "utr", header: "UTR", render: (r) => <span className="font-mono text-xs">{r.utr || "—"}</span> },
    { key: "match_result", header: "Match", render: (r) => <Badge variant={r.match_result === "CORRECT" ? "success" : r.match_result === "DUPLICATE" ? "danger" : "warning"}>{r.match_result}</Badge> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
  ];

  return (
    <>
      <Link href="/p2p" className="mb-3 inline-flex items-center gap-1 text-sm text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]"><ChevronLeft className="h-4 w-4" /> Traders</Link>
      <PageHeader title={`${t.trader_code} · ${t.name}`} description={`${t.kind} · VPA ${t.vpa_mode.toLowerCase()} · risk ${t.risk_tier}`} icon={Users}
        actions={<Badge variant={statusVariant(t.status)}>{t.status}</Badge>} />

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Limits & status</CardTitle><CardDescription>Per-txn / daily caps and trader status.</CardDescription></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Per-txn max</span><span className="tabular-nums">{formatAmount(t.per_txn_max)}</span></div>
            <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Daily amount max</span><span className="tabular-nums">{formatAmount(t.daily_amount_max)}</span></div>
            <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Daily count max</span><span className="tabular-nums">{t.daily_count_max}</span></div>
            <div className="flex gap-2 pt-2">
              {t.status === "ACTIVE"
                ? <Button size="sm" variant="secondary" onClick={() => patch.mutate({ status: "SUSPENDED" })}>Suspend</Button>
                : <Button size="sm" onClick={() => patch.mutate({ status: "ACTIVE" })}>Reactivate</Button>}
              {(["LOW", "MEDIUM", "HIGH"] as const).map((rt) => (
                <Button key={rt} size="sm" variant="ghost" onClick={() => patch.mutate({ risk_tier: rt })}>{rt}</Button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">VPAs ({vpas.length})</CardTitle><CardDescription>{t.kind === "BUSINESS" ? "Pool VPAs (static/dynamic)." : "Trader VPAs."}</CardDescription></CardHeader>
          <CardContent>
            <DataTable columns={vCols} rows={vpas} rowKey={(r) => r.id} emptyState="No VPAs yet." />
            <div className="mt-3 flex gap-2">
              <Input value={vpa} onChange={(e) => setVpa(e.target.value)} placeholder="add@upi" />
              <Button size="sm" disabled={!vpa.trim() || patch.isPending} onClick={() => { patch.mutate({ action: "add_vpa", vpa }); setVpa(""); }}><Plus className="h-4 w-4" /> Add</Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Record collection · UTR match</CardTitle><CardDescription>Enforces per-txn + daily limits, duplicate-UTR, and wrong-amount detection.</CardDescription></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="space-y-1.5"><Label>Amount</Label><Input type="number" value={coll.amount} onChange={(e) => setColl({ ...coll, amount: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>UTR</Label><Input value={coll.utr} onChange={(e) => setColl({ ...coll, utr: e.target.value })} placeholder="412345678901" /></div>
            <div className="space-y-1.5"><Label>VPA <span className="font-normal text-[color:var(--color-text-muted)]">(opt)</span></Label><Input value={coll.vpa} onChange={(e) => setColl({ ...coll, vpa: e.target.value })} placeholder="trader@upi" /></div>
            <div className="space-y-1.5"><Label>Expected <span className="font-normal text-[color:var(--color-text-muted)]">(opt)</span></Label><Input type="number" value={coll.expected_amount} onChange={(e) => setColl({ ...coll, expected_amount: e.target.value })} /></div>
          </div>
          <div className="mt-3 flex justify-end">
            <Button disabled={collect.isPending || !coll.amount || coll.utr.length < 4} onClick={() => collect.mutate()}><Link2 className="h-4 w-4" /> Match UTR</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Collections ({collections.length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={cCols} rows={collections} rowKey={(r) => r.id} emptyState="No collections yet." /></CardContent>
      </Card>
    </>
  );
}
