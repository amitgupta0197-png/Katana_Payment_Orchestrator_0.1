"use client";

// Merchant controls (Katana BRD FR-003, §11.A, §27): transaction limits and the
// approved line-of-business (purpose) allow-list per merchant.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontal, Save } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/world-class/money-input";
import { formatAmount } from "@/lib/utils";

export default function FifoControlsPage() {
  const qc = useQueryClient();
  const [lim, setLim] = useState({ merchant_id: "", per_txn: "", daily: "", monthly: "" });
  const [lob, setLob] = useState({ merchant_id: "", allowed_purposes: "", mcc: "" });

  const limits = useQuery({ queryKey: ["merchant-limits"], queryFn: async () => (await fetch("/api/v1/merchant-limits").then((r) => r.json())) as { limits: any[] } });
  const lobs = useQuery({ queryKey: ["merchant-lobs"], queryFn: async () => (await fetch("/api/v1/merchant-lob").then((r) => r.json())) as { lobs: any[] } });

  const saveLimit = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/v1/merchant-limits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ merchant_id: lim.merchant_id, per_txn: lim.per_txn || undefined, daily: lim.daily || undefined, monthly: lim.monthly || undefined }) });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status); return d;
    },
    onSuccess: () => { toast.success("Limits saved"); qc.invalidateQueries({ queryKey: ["merchant-limits"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const saveLob = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/v1/merchant-lob", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ merchant_id: lob.merchant_id, allowed_purposes: lob.allowed_purposes.split(",").map((s) => s.trim()).filter(Boolean), mcc: lob.mcc || undefined }) });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status); return d;
    },
    onSuccess: () => { toast.success("LOB saved"); qc.invalidateQueries({ queryKey: ["merchant-lobs"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  return (
    <>
      <PageHeader title="Branch Controls" description="Transaction limits and approved line-of-business per branch (BRD FR-003, §11.A, §27)." icon={SlidersHorizontal} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Transaction limits</CardTitle><CardDescription>Blank = no limit on that dimension. Amounts in ₹.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            <Input className="h-9" placeholder="branch code e.g. M10001" value={lim.merchant_id} onChange={(e) => setLim({ ...lim, merchant_id: e.target.value })} />
            <div className="grid grid-cols-3 gap-2">
              <MoneyInput placeholder="per-txn" value={lim.per_txn} onChange={(v) => setLim({ ...lim, per_txn: v })} />
              <MoneyInput placeholder="daily" value={lim.daily} onChange={(v) => setLim({ ...lim, daily: v })} />
              <MoneyInput placeholder="monthly" value={lim.monthly} onChange={(v) => setLim({ ...lim, monthly: v })} />
            </div>
            <Button size="sm" onClick={() => saveLimit.mutate()} disabled={!lim.merchant_id || saveLimit.isPending}><Save className="h-4 w-4" /> Save limits</Button>
            <div className="space-y-1 pt-2">
              {(limits.data?.limits ?? []).map((l) => (
                <div key={l.merchant_id} className="rounded-md border px-3 py-1.5 text-xs">
                  <span className="font-mono">{l.merchant_id}</span> · per-txn {l.per_txn_minor ? formatAmount(Number(l.per_txn_minor), l.currency) : "—"} · daily {l.daily_minor ? formatAmount(Number(l.daily_minor), l.currency) : "—"} · monthly {l.monthly_minor ? formatAmount(Number(l.monthly_minor), l.currency) : "—"}
                </div>
              ))}
              {(limits.data?.limits ?? []).length === 0 && <div className="text-xs text-[color:var(--color-text-muted)]">No limits set.</div>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Approved line-of-business</CardTitle><CardDescription>Comma-separated purposes. Orders with an off-list purpose are flagged.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            <Input className="h-9" placeholder="branch code" value={lob.merchant_id} onChange={(e) => setLob({ ...lob, merchant_id: e.target.value })} />
            <Input className="h-9" placeholder="allowed purposes e.g. service_payment, recharge" value={lob.allowed_purposes} onChange={(e) => setLob({ ...lob, allowed_purposes: e.target.value })} />
            <Input className="h-9" placeholder="MCC (optional)" value={lob.mcc} onChange={(e) => setLob({ ...lob, mcc: e.target.value })} />
            <Button size="sm" onClick={() => saveLob.mutate()} disabled={!lob.merchant_id || saveLob.isPending}><Save className="h-4 w-4" /> Save LOB</Button>
            <div className="space-y-1 pt-2">
              {(lobs.data?.lobs ?? []).map((l) => (
                <div key={l.merchant_id} className="rounded-md border px-3 py-1.5 text-xs">
                  <span className="font-mono">{l.merchant_id}</span> · {(l.allowed_purposes ?? []).join(", ") || "—"}{l.mcc ? ` · MCC ${l.mcc}` : ""}
                </div>
              ))}
              {(lobs.data?.lobs ?? []).length === 0 && <div className="text-xs text-[color:var(--color-text-muted)]">No LOB set.</div>}
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
