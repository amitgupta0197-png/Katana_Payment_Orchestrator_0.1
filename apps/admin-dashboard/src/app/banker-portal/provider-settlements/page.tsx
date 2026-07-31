"use client";

// BRANCH view of provider settlements: the provider asks the branch to settle the
// amount it collected. The branch pays the shown beneficiary account, then submits
// the UTR here. Status updates live (10s) as the provider verifies.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, Send, Activity, Copy } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatAmount, formatDateTime } from "@/lib/utils";
import { settlementStatusVariant, SETTLEMENT_STATUS_LABEL } from "@/components/settlement/status";

interface Settlement {
  id: string; provider_code?: string; provider_name?: string; amount: number; currency: string; status: string;
  utr?: string; purpose?: string; transfer_mode?: string; beneficiary_snapshot?: any; requested_at: string; note?: string;
}

export default function BranchProviderSettlementsPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["settlements", "branch"],
    queryFn: async () => (await fetch("/api/settlements").then((r) => r.json())) as { settlements: Settlement[] },
    refetchInterval: 10_000,
  });
  const [utrFor, setUtrFor] = useState<Settlement | null>(null);

  const list = q.data?.settlements ?? [];
  const toPay = list.filter((x) => x.status === "REQUESTED" || x.status === "REJECTED").reduce((s, x) => s + Number(x.amount || 0), 0);

  const cols: Column<Settlement>[] = [
    { key: "provider", header: "Provider", render: (r) => <span className="font-medium">{r.provider_name ?? r.provider_code ?? "—"}</span> },
    { key: "amount", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(r.amount, r.currency)}</span> },
    { key: "beneficiary", header: "Pay to", render: (r) => {
      const b = r.beneficiary_snapshot ?? {};
      return <span className="text-xs">{b.beneficiary_name ?? "—"}{b.vpa ? ` · ${b.vpa}` : b.account_number ? ` · ${b.account_number} (${b.ifsc ?? ""})` : ""}<Badge variant="info" >{r.transfer_mode ?? b.transfer_mode}</Badge></span>;
    } },
    { key: "utr", header: "UTR", render: (r) => r.utr ? <span className="font-mono text-xs">{r.utr}</span> : <span className="text-[color:var(--color-text-subtle)]">—</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={settlementStatusVariant(r.status)}>{SETTLEMENT_STATUS_LABEL[r.status] ?? r.status}</Badge> },
    { key: "requested_at", header: "Raised", render: (r) => <span className="text-xs">{formatDateTime(r.requested_at)}</span> },
    { key: "actions", header: "", render: (r) => (r.status === "REQUESTED" || r.status === "REJECTED")
      ? <Button size="sm" onClick={() => setUtrFor(r)}><Send className="h-4 w-4" /> Submit UTR</Button>
      : null },
  ];

  return (
    <>
      <PageHeader
        title="Provider settlements"
        description="Settlements your provider has raised. Pay the shown beneficiary account, then submit the UTR so the provider can verify it."
        icon={Banknote}
        actions={<Badge variant={q.isFetching ? "info" : "default"}><Activity className="h-3 w-3 mr-1" />live · 10s</Badge>}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">To pay / resubmit</div><div className="text-2xl font-semibold tabular-nums">{formatAmount(toPay)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Awaiting verification</div><div className="text-2xl font-semibold tabular-nums">{list.filter((x) => x.status === "UTR_SUBMITTED").length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-[color:var(--color-text-muted)]">Verified</div><div className="text-2xl font-semibold tabular-nums">{list.filter((x) => x.status === "VERIFIED").length}</div></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Settlement requests</CardTitle><CardDescription>Submit the UTR after you pay — your provider verifies it in real time.</CardDescription></CardHeader>
        <CardContent>
          <DataTable columns={cols} rows={list} rowKey={(r) => r.id} loading={q.isLoading} emptyState="No settlement requests from your provider yet." />
        </CardContent>
      </Card>

      <SubmitUtrDialog settlement={utrFor} onClose={() => setUtrFor(null)} onDone={() => { setUtrFor(null); qc.invalidateQueries({ queryKey: ["settlements"] }); }} />
    </>
  );
}

function SubmitUtrDialog({ settlement, onClose, onDone }: { settlement: Settlement | null; onClose: () => void; onDone: () => void }) {
  const [utr, setUtr] = useState("");
  const [note, setNote] = useState("");
  const submit = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/settlements/${settlement!.id}/utr`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ utr, note: note || undefined }) });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "Failed"); return d;
    },
    onSuccess: () => { toast.success("UTR submitted", { description: "Your provider will verify it shortly." }); setUtr(""); setNote(""); onDone(); },
    onError: (e: Error) => toast.error("Couldn’t submit", { description: e.message }),
  });
  const b = settlement?.beneficiary_snapshot ?? {};
  const copy = (s?: string) => { if (s) { navigator.clipboard.writeText(s); toast.success("Copied"); } };
  return (
    <Dialog open={!!settlement} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Submit settlement UTR</DialogTitle><DialogDescription>Pay {settlement ? formatAmount(settlement.amount, settlement.currency) : ""} to the account below, then enter the UTR.</DialogDescription></DialogHeader>
        {settlement && (
          <div className="rounded-md border bg-[color:var(--color-surface-muted)] p-3 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Beneficiary</span><span className="font-medium">{b.beneficiary_name}</span></div>
            {b.vpa ? <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">VPA</span><button className="font-mono inline-flex items-center gap-1" onClick={() => copy(b.vpa)}>{b.vpa} <Copy className="h-3 w-3" /></button></div> : <>
              <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Account</span><button className="font-mono inline-flex items-center gap-1" onClick={() => copy(b.account_number)}>{b.account_number} <Copy className="h-3 w-3" /></button></div>
              <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">IFSC</span><button className="font-mono inline-flex items-center gap-1" onClick={() => copy(b.ifsc)}>{b.ifsc} <Copy className="h-3 w-3" /></button></div>
            </>}
            <div className="flex justify-between"><span className="text-[color:var(--color-text-muted)]">Mode</span><span>{settlement.transfer_mode ?? b.transfer_mode}</span></div>
          </div>
        )}
        <div className="space-y-3">
          <div><Label className="text-xs">UTR / RRN</Label><Input value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="bank reference of your payment" /></div>
          <div><Label className="text-xs">Note (optional)</Label><Input value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => submit.mutate()} disabled={submit.isPending || utr.trim().length < 4}><Send className="h-4 w-4" /> Submit UTR</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
