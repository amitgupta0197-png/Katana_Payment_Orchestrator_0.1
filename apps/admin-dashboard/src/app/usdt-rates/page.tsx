"use client";

// ADMIN — daily USDT settlement rate management (BRD §9). Katana declares the
// settlement rate per network; a USDT settlement locks the applicable rate at request
// creation. The newest effective, unexpired rate per network is "today's rate".

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, Plus, Activity } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDateTime } from "@/lib/utils";

interface Rate {
  id: string; network: string; market_rate: number | null; buy_rate: number | null; sell_rate: number | null;
  settlement_rate: number; katana_spread: number; downline_spread: number; network_fee: number;
  effective_from: string; expiry_at: string | null; created_by: string | null;
}

const NETWORKS = ["TRC20", "ERC20", "BEP20"];

export default function UsdtRatesPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["usdt-rates-admin"],
    queryFn: async () => (await fetch("/api/usdt-rates").then((r) => r.json())) as { current: Record<string, Rate>; rates: Rate[] },
    refetchInterval: 30_000,
  });
  const [open, setOpen] = useState(false);

  const current = q.data?.current ?? {};
  const list = q.data?.rates ?? [];

  const cols: Column<Rate>[] = [
    { key: "network", header: "Network", render: (r) => <Badge variant="brand">{r.network}</Badge> },
    { key: "settlement_rate", header: "Settlement ₹/USDT", render: (r) => <span className="tabular-nums font-medium">₹{r.settlement_rate}</span> },
    { key: "market", header: "Market / Buy / Sell", render: (r) => <span className="tabular-nums text-xs">{r.market_rate ?? "—"} / {r.buy_rate ?? "—"} / {r.sell_rate ?? "—"}</span> },
    { key: "fee", header: "Network fee (USDT)", render: (r) => <span className="tabular-nums text-xs">{r.network_fee}</span> },
    { key: "effective", header: "Effective", render: (r) => <span className="text-xs">{formatDateTime(r.effective_from)}{r.expiry_at ? ` → ${formatDateTime(r.expiry_at)}` : ""}</span> },
    { key: "by", header: "Declared by", render: (r) => <span className="text-xs text-[color:var(--color-text-muted)]">{r.created_by ?? "—"}</span> },
  ];

  return (
    <>
      <PageHeader
        title="USDT rates"
        description="Declare the daily USDT settlement rate per network. The newest effective rate is locked onto each USDT settlement at request creation."
        icon={Coins}
        actions={<div className="flex items-center gap-2">
          <Badge variant={q.isFetching ? "info" : "default"}><Activity className="h-3 w-3 mr-1" />live</Badge>
          <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Declare rate</Button>
        </div>}
      />

      <div className="mb-6 grid grid-cols-1 sm:grid-cols-3 gap-3">
        {NETWORKS.map((n) => (
          <Card key={n}><CardContent className="p-4">
            <div className="text-xs text-[color:var(--color-text-muted)]">{n} today</div>
            <div className="text-2xl font-semibold tabular-nums">{current[n] ? `₹${current[n].settlement_rate}` : "—"}</div>
            {current[n]?.network_fee ? <div className="text-[10px] text-[color:var(--color-text-muted)]">fee {current[n].network_fee} USDT</div> : null}
          </CardContent></Card>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Rate history</CardTitle><CardDescription>Settlements keep the rate they locked at request time — later declarations never reprice them.</CardDescription></CardHeader>
        <CardContent>
          <DataTable columns={cols} rows={list} rowKey={(r) => r.id} loading={q.isLoading} emptyState="No rates declared yet — USDT settlements can't be raised until one is set." />
        </CardContent>
      </Card>

      <DeclareRateDialog open={open} onOpenChange={setOpen} onDone={() => { setOpen(false); qc.invalidateQueries({ queryKey: ["usdt-rates-admin"] }); }} />
    </>
  );
}

function DeclareRateDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [form, setForm] = useState({ network: "TRC20", settlement_rate: "", market_rate: "", buy_rate: "", sell_rate: "", network_fee: "" });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/usdt-rates", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: form.network,
          settlement_rate: Number(form.settlement_rate),
          market_rate: form.market_rate ? Number(form.market_rate) : null,
          buy_rate: form.buy_rate ? Number(form.buy_rate) : null,
          sell_rate: form.sell_rate ? Number(form.sell_rate) : null,
          network_fee: Number(form.network_fee || 0),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d;
    },
    onSuccess: () => { toast.success(`${form.network} rate declared`); onDone(); },
    onError: (e: Error) => toast.error("Couldn’t declare rate", { description: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Declare today's USDT rate</DialogTitle>
          <DialogDescription>Applies from now until you declare a newer rate for the network.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div><Label className="text-xs">Network</Label>
            <select value={form.network} onChange={(e) => set("network", e.target.value)} className="w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm">
              {NETWORKS.map((n) => <option key={n}>{n}</option>)}
            </select></div>
          <div><Label className="text-xs">Settlement rate (₹/USDT)</Label><Input type="number" step="0.01" value={form.settlement_rate} onChange={(e) => set("settlement_rate", e.target.value)} placeholder="88.50" /></div>
          <div><Label className="text-xs">Market ref (optional)</Label><Input type="number" step="0.01" value={form.market_rate} onChange={(e) => set("market_rate", e.target.value)} /></div>
          <div><Label className="text-xs">Network fee (USDT)</Label><Input type="number" step="0.01" value={form.network_fee} onChange={(e) => set("network_fee", e.target.value)} placeholder="2" /></div>
          <div><Label className="text-xs">Buy rate (optional)</Label><Input type="number" step="0.01" value={form.buy_rate} onChange={(e) => set("buy_rate", e.target.value)} /></div>
          <div><Label className="text-xs">Sell rate (optional)</Label><Input type="number" step="0.01" value={form.sell_rate} onChange={(e) => set("sell_rate", e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !(Number(form.settlement_rate) > 0)}>Declare rate</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
