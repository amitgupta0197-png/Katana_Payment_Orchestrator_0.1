"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Network, ChevronLeft, ShieldCheck, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface SubMid {
  id: string; sub_mid_code: string; main_mid_code: string; merchant_id: string;
  provider_id: string; traffic_mode: string; kyc_status: string;
  settlement_enabled: boolean; status: string; active_payin?: boolean;
  requested_at: string; approved_at?: string; approved_by: string;
}

// One-click: assign this sub-MID to a provider + toggle it as the active pay-in
// target for its merchant (new payins route through and are attributed to it).
function ProviderRoutingCard({ sub }: { sub: SubMid }) {
  const qc = useQueryClient();
  const provQ = useQuery({
    queryKey: ["providers"],
    queryFn: async () => {
      const r = await fetch("/api/providers");
      if (!r.ok) return { providers: [] as { id: string; code: string; legal_name: string }[] };
      return (await r.json()) as { providers: { id: string; code: string; legal_name: string }[] };
    },
  });
  const providers = provQ.data?.providers ?? [];
  const m = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const r = await fetch(`/api/sub-mids/${sub.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sub-mid", sub.id] }); qc.invalidateQueries({ queryKey: ["sub-mids"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const selClass = "flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]";
  return (
    <Card className="mb-4">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Provider & pay-in routing</CardTitle>
          <CardDescription>Assign to a provider; make active so new payins route through this sub-MID.</CardDescription>
        </div>
        <Badge variant={sub.active_payin ? "success" : "default"}>{sub.active_payin ? "active payin" : "inactive"}</Badge>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="space-y-1.5">
          <span className="text-[color:var(--color-text-muted)]">Provider</span>
          <select className={selClass} value={sub.provider_id || ""}
            onChange={(e) => m.mutate({ action: "assign_provider", provider_id: e.target.value || null })} disabled={m.isPending}>
            <option value="">— Unassigned —</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.legal_name}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          {sub.active_payin ? (
            <Button size="sm" variant="secondary" onClick={() => m.mutate({ action: "clear_active_payin" })} disabled={m.isPending}>
              Stop routing payins here
            </Button>
          ) : (
            <Button size="sm" onClick={() => m.mutate({ action: "set_active_payin" })} disabled={m.isPending}>
              Route new payins through this sub-MID
            </Button>
          )}
          <span className="text-xs text-[color:var(--color-text-muted)]">One active sub-MID per merchant ({sub.merchant_id}).</span>
        </div>
      </CardContent>
    </Card>
  );
}
interface Limits { id: string; per_txn_max: number; daily_amount: number; daily_count: number; monthly_amount: number; created_at: string }
interface HistoryRow { id: string; from_status: string; to_status: string; from_mode: string; to_mode: string; actor: string; notes: string; created_at: string }

function ActionButtons({ sub }: { sub: SubMid }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async (action: string) => {
      const r = await fetch(`/api/sub-mids/${sub.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: (_, action) => {
      toast.success(`Action: ${action}`);
      qc.invalidateQueries({ queryKey: ["sub-mid", sub.id] });
      qc.invalidateQueries({ queryKey: ["sub-mids"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  return (
    <div className="flex flex-wrap gap-2">
      {sub.kyc_status !== "APPROVED" && (
        <Button size="sm" onClick={() => m.mutate("approve_kyc")} disabled={m.isPending}>
          <ShieldCheck className="h-4 w-4" /> Approve KYC
        </Button>
      )}
      {sub.kyc_status === "APPROVED" && !sub.settlement_enabled && (
        <Button size="sm" onClick={() => m.mutate("enable_settlement")} disabled={m.isPending}>
          Enable settlement
        </Button>
      )}
      {sub.kyc_status !== "APPROVED" && (
        <Button size="sm" variant="secondary" onClick={() => m.mutate("approve_and_enable")} disabled={m.isPending}>
          Approve KYC + enable settlement
        </Button>
      )}
      {sub.status === "ACTIVE" && (
        <Button size="sm" variant="secondary" onClick={() => m.mutate("suspend")} disabled={m.isPending}>
          Suspend
        </Button>
      )}
      {sub.status !== "TERMINATED" && (
        <Button size="sm" variant="danger" onClick={() => { if (confirm(`Terminate ${sub.sub_mid_code}?`)) m.mutate("terminate"); }} disabled={m.isPending}>
          <AlertTriangle className="h-4 w-4" /> Terminate
        </Button>
      )}
    </div>
  );
}

export default function SubMidDetailView({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["sub-mid", id],
    queryFn: async () => (await fetch(`/api/sub-mids/${id}`).then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as {
      sub_mid: SubMid; limits: Limits | null; history: HistoryRow[];
    },
  });

  if (q.isLoading) return <Card><CardContent className="py-8 text-center">Loading…</CardContent></Card>;
  if (!q.data?.sub_mid) {
    return (
      <>
        <PageHeader title="Sub-MID not found" icon={Network} />
        <Card><CardContent className="py-8 text-center"><Link className="text-[color:var(--color-brand)] hover:underline" href="/sub-mids">← back to sub-MIDs</Link></CardContent></Card>
      </>
    );
  }

  const { sub_mid: sub, limits, history } = q.data;
  const hCols: Column<HistoryRow>[] = [
    { key: "created_at", header: "When", render: (r) => formatDateTime(r.created_at) },
    { key: "from_status", header: "From", render: (r) => `${r.from_status ?? "—"}/${r.from_mode ?? "—"}` },
    { key: "to_status", header: "To", render: (r) => `${r.to_status}/${r.to_mode ?? "—"}` },
    { key: "actor", header: "Actor" },
    { key: "notes", header: "Notes" },
  ];

  return (
    <>
      <PageHeader
        title={sub.sub_mid_code}
        description={`Main MID ${sub.main_mid_code} · merchant ${sub.merchant_id} · provider ${sub.provider_id || "—"}`}
        icon={Network}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={statusVariant(sub.traffic_mode)}>{sub.traffic_mode}</Badge>
            <Badge variant={statusVariant(sub.kyc_status)}>KYC {sub.kyc_status}</Badge>
            {sub.settlement_enabled ? <Badge variant="success">settle on</Badge> : <Badge variant="default">settle off</Badge>}
            <Badge variant={statusVariant(sub.status)}>{sub.status}</Badge>
            <Link href="/sub-mids" className="text-xs text-[color:var(--color-text-muted)] hover:text-[color:var(--color-brand)] inline-flex items-center"><ChevronLeft className="h-3 w-3" /> back</Link>
          </div>
        }
      />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Approval workflow</CardTitle>
          <CardDescription>
            §3.2 invariant: settlement_enabled cannot be true unless kyc_status=APPROVED. Approval auto-upgrades traffic_mode TRAFFIC → KYC_APPROVED.
          </CardDescription>
        </CardHeader>
        <CardContent><ActionButtons sub={sub} /></CardContent>
      </Card>

      <ProviderRoutingCard sub={sub} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 mb-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Identity</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div><span className="text-[color:var(--color-text-muted)]">Sub-MID code:</span> <span className="font-mono">{sub.sub_mid_code}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">Main MID:</span> <span className="font-mono">{sub.main_mid_code}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">Merchant:</span> <span className="font-mono">{sub.merchant_id}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">Provider:</span> <span className="font-mono">{sub.provider_id || "—"}</span></div>
            <div><span className="text-[color:var(--color-text-muted)]">Requested:</span> {formatDateTime(sub.requested_at)}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Approved:</span> {sub.approved_at ? formatDateTime(sub.approved_at) : "—"}</div>
            <div><span className="text-[color:var(--color-text-muted)]">Approved by:</span> {sub.approved_by || "—"}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Limits</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            {limits ? (
              <>
                <div><span className="text-[color:var(--color-text-muted)]">Per-txn max:</span> {limits.per_txn_max ?? "—"}</div>
                <div><span className="text-[color:var(--color-text-muted)]">Daily amount:</span> {limits.daily_amount ?? "—"}</div>
                <div><span className="text-[color:var(--color-text-muted)]">Daily count:</span> {limits.daily_count ?? "—"}</div>
                <div><span className="text-[color:var(--color-text-muted)]">Monthly amount:</span> {limits.monthly_amount ?? "—"}</div>
              </>
            ) : (
              <p className="text-[color:var(--color-text-muted)]">No limits configured.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Status history ({history.length})</CardTitle></CardHeader>
        <CardContent><DataTable columns={hCols} rows={history} rowKey={(r) => r.id} emptyState="No transitions yet." /></CardContent>
      </Card>
    </>
  );
}
