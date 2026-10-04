"use client";

// A banker's place in the Bank → TSP → Banker chain and the MIDs its bank issued it (lib/chain).
// Staff only: a TSP is a gateway's company and is never named to a merchant or banker login, so
// this component is rendered only on the staff banker page's MIDs tab.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Landmark, Plus, History } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";
import { maskMid, type Flow, type MidStatus } from "@/lib/chain";
import type { BankerChain, IssuedMid } from "@/lib/chain-store";

const FLOW_LABEL: Record<Flow, string> = { INTENT: "Intent pay-in", P2P: "P2P pay-in", PAYOUT: "Payout" };
const STATUS_LABEL: Record<MidStatus, string> = {
  PENDING_APPROVAL: "Waiting for approval", ACTIVE: "Active", INACTIVE: "Inactive", REJECTED: "Rejected",
};
const STATUS_VARIANT: Record<MidStatus, "warning" | "success" | "default" | "danger"> = {
  PENDING_APPROVAL: "warning", ACTIVE: "success", INACTIVE: "default", REJECTED: "danger",
};
const statusLabel = (s: string | null) => (s ? STATUS_LABEL[s as MidStatus] ?? s : "New");

const selectCls = "flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)] disabled:opacity-50";
const muted = "text-[color:var(--color-text-muted)]";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init ? { ...init, headers: { "Content-Type": "application/json" } } : undefined);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
  return d as T;
}

export function BankerMids({ merchantId, canEdit }: { merchantId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const key = ["merchant", merchantId, "chain"];
  const q = useQuery({ queryKey: key, queryFn: () => call<BankerChain>(`/api/merchants/${merchantId}/chain`) });
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  if (q.isLoading) return <Card><CardContent className={`py-8 text-center text-sm ${muted}`}>Loading…</CardContent></Card>;
  if (q.error || !q.data) {
    return <Card><CardContent className="py-8 text-center text-sm text-[color:var(--color-danger)]">Could not load MIDs: {(q.error as Error)?.message ?? "no data"}</CardContent></Card>;
  }
  const c = q.data;
  return (
    <div className="space-y-4">
      <ChainCard merchantId={merchantId} chain={c} canEdit={canEdit} onSaved={refresh} />
      <MidsCard merchantId={merchantId} chain={c} canEdit={canEdit} onChanged={refresh} />
      <HistoryCard chain={c} />
    </div>
  );
}

// ── Bank and TSP ────────────────────────────────────────────────────────────────────────────

function ChainCard({ merchantId, chain, canEdit, onSaved }: { merchantId: string; chain: BankerChain; canEdit: boolean; onSaved: () => void }) {
  const [tspId, setTspId] = useState(chain.tsp?.id ?? "");
  const [bankId, setBankId] = useState(chain.bank?.id ?? "");
  useEffect(() => { setTspId(chain.tsp?.id ?? ""); setBankId(chain.bank?.id ?? ""); }, [chain.tsp?.id, chain.bank?.id]);
  const tspOpt = chain.options.find((o) => o.id === tspId);
  const banks = tspOpt?.banks ?? [];
  const unchanged = tspId === (chain.tsp?.id ?? "") && bankId === (chain.bank?.id ?? "");

  const save = useMutation({
    mutationFn: () => call(`/api/merchants/${merchantId}/chain`, { method: "PUT", body: JSON.stringify({ tsp_id: tspId, bank_id: bankId }) }),
    onSuccess: () => { toast.success("TSP and issuing bank saved"); onSaved(); },
    onError: (e: Error) => toast.error("Could not save", { description: e.message }),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><Landmark className="h-4 w-4" /> Bank and TSP</CardTitle>
        <CardDescription>The bank issues this banker&apos;s MIDs through this TSP.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className={`text-xs ${muted}`}>TSP</dt>
            <dd className="mt-0.5">
              {chain.tsp ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{chain.tsp.code}</span> {chain.tsp.name}
                  <Badge variant={statusVariant(chain.tsp.stage)}>{chain.tsp.stage}</Badge>
                </span>
              ) : <span className={muted}>Not set</span>}
            </dd>
          </div>
          <div>
            <dt className={`text-xs ${muted}`}>Issuing bank</dt>
            <dd className="mt-0.5">
              {chain.bank ? <><span className="font-mono">{chain.bank.code}</span> {chain.bank.name}</> : <span className={muted}>Not set</span>}
            </dd>
          </div>
        </dl>

        {canEdit && (chain.options.length === 0 ? (
          <div className={`rounded-md border px-3 py-2 text-xs ${muted}`}>
            No TSP is live yet. Take one live on the <Link href="/tsps" className="text-[color:var(--color-brand)] hover:underline">TSPs page</Link> first.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="chain-tsp">TSP</Label>
              <select id="chain-tsp" className={selectCls} value={tspId} onChange={(e) => { setTspId(e.target.value); setBankId(""); }}>
                <option value="">Choose a live TSP</option>
                {chain.options.map((o) => <option key={o.id} value={o.id}>{o.code} · {o.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="chain-bank">Issuing bank</Label>
              <select id="chain-bank" className={selectCls} value={bankId} onChange={(e) => setBankId(e.target.value)} disabled={!tspId}>
                <option value="">{tspId && !banks.length ? "No bank has confirmed this TSP" : "Choose a bank"}</option>
                {banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
              </select>
            </div>
            <Button onClick={() => save.mutate()} disabled={!tspId || !bankId || unchanged || save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── Issued MIDs ─────────────────────────────────────────────────────────────────────────────

function MidsCard({ merchantId, chain, canEdit, onChanged }: { merchantId: string; chain: BankerChain; canEdit: boolean; onChanged: () => void }) {
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [deactivating, setDeactivating] = useState<IssuedMid | null>(null);

  const withdraw = useMutation({
    mutationFn: (mid: IssuedMid) => call(`/api/merchants/${merchantId}/issued-mids/${mid.id}`, { method: "POST", body: JSON.stringify({ action: "withdraw" }) }),
    onSuccess: () => { toast.success("MID withdrawn"); onChanged(); },
    onError: (e: Error) => toast.error("Could not withdraw", { description: e.message }),
  });

  const money = (v: string | null, cur: string) => (v ? formatAmount(v, cur || "INR") : "—");
  const cols: Column<IssuedMid>[] = [
    { key: "flow", header: "Flow", render: (r) => FLOW_LABEL[r.flow] ?? r.flow },
    {
      key: "mid_value", header: "MID", render: (r) => (
        <span className="inline-flex items-center gap-1">
          <span className="font-mono text-xs">{shown[r.id] ? r.mid_value : maskMid(r.mid_value)}</span>
          <button type="button" className={`${muted} hover:text-[color:var(--color-text)]`} aria-label={shown[r.id] ? "Hide MID" : "Show MID"}
            onClick={() => setShown((s) => ({ ...s, [r.id]: !s[r.id] }))}>
            {shown[r.id] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </span>
      ),
    },
    { key: "issued_on", header: "Issued", render: (r) => r.issued_on ?? "—" },
    { key: "expires_on", header: "Expires", render: (r) => r.expires_on ?? "—" },
    { key: "daily_limit", header: "Daily limit", render: (r) => money(r.daily_limit, r.currency) },
    { key: "monthly_limit", header: "Monthly limit", render: (r) => money(r.monthly_limit, r.currency) },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>{STATUS_LABEL[r.status] ?? r.status}</Badge> },
    { key: "tsp_code", header: "TSP", render: (r) => <span className="font-mono text-xs">{r.tsp_code}</span> },
    { key: "bank_code", header: "Bank", render: (r) => <span className="font-mono text-xs">{r.bank_code}</span> },
    { key: "requested_by", header: "Requested by", render: (r) => <span className="text-xs">{r.requested_by}</span> },
    {
      key: "decided_by", header: "Decided by", render: (r) => r.decided_by
        ? <span className="text-xs">{r.decided_by}{r.decided_at && <span className={`block ${muted}`}>{formatDateTime(r.decided_at)}</span>}</span>
        : "—",
    },
    ...(canEdit ? [{
      key: "actions", header: "", render: (r: IssuedMid) => r.status === "PENDING_APPROVAL" ? (
        <Button size="sm" variant="secondary" disabled={withdraw.isPending} onClick={() => withdraw.mutate(r)}>Withdraw</Button>
      ) : r.status === "ACTIVE" ? (
        <Button size="sm" variant="secondary" onClick={() => setDeactivating(r)}>Deactivate</Button>
      ) : null,
    }] : []),
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Issued MIDs</CardTitle>
        <CardDescription>
          The MIDs the issuing bank gave this banker. Recording a MID does not move traffic; the{" "}
          <Link href="/mid-switch" className="text-[color:var(--color-brand)] hover:underline">MID switch</Link> decides which account takes orders.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <DataTable columns={cols} rows={chain.mids} rowKey={(r) => r.id} emptyState="No MIDs recorded for this banker yet." />
        {canEdit && <RecordMidForm merchantId={merchantId} chain={chain} onDone={onChanged} />}
      </CardContent>
      {deactivating && (
        <DeactivateDialog merchantId={merchantId} mid={deactivating} onClose={() => setDeactivating(null)} onDone={onChanged} />
      )}
    </Card>
  );
}

function DeactivateDialog({ merchantId, mid, onClose, onDone }: { merchantId: string; mid: IssuedMid; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => call<{ request_id?: string }>(`/api/merchants/${merchantId}/issued-mids/${mid.id}`, {
      method: "POST", body: JSON.stringify({ action: "deactivate", reason: reason.trim() }),
    }),
    onSuccess: () => {
      toast.success("Deactivation requested", {
        description: <span>It waits for a second Super Admin on <Link href="/admin/maker-checker" className="underline">Maker-Checker</Link>.</span>,
      });
      onDone(); onClose();
    },
    onError: (e: Error) => toast.error("Could not request deactivation", { description: e.message }),
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deactivate MID</DialogTitle>
          <DialogDescription>
            {FLOW_LABEL[mid.flow]} MID <span className="font-mono">{maskMid(mid.mid_value)}</span>. A second Super Admin must approve before it stops being active.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="mid-deactivate-reason">Reason</Label>
          <Input id="mid-deactivate-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. bank withdrew the MID" />
          {reason.trim().length > 0 && reason.trim().length < 5 && <p className={`text-xs ${muted}`}>At least 5 characters.</p>}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => m.mutate()} disabled={reason.trim().length < 5 || m.isPending}>
            {m.isPending ? "Requesting…" : "Request deactivation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecordMidForm({ merchantId, chain, onDone }: { merchantId: string; chain: BankerChain; onDone: () => void }) {
  const flows = chain.tsp?.allowed_flows ?? [];
  const [flow, setFlow] = useState<string>(flows[0] ?? "");
  const [value, setValue] = useState("");
  const [issuedOn, setIssuedOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [daily, setDaily] = useState("");
  const [monthly, setMonthly] = useState("");
  useEffect(() => { if (!flows.includes(flow as Flow)) setFlow(flows[0] ?? ""); }, [flows, flow]);

  const blocked = !chain.tsp ? "Choose the banker's TSP and issuing bank first."
    : !chain.bank ? "Choose the banker's issuing bank first."
    : chain.tsp.stage !== "LIVE" ? `The banker's TSP is ${chain.tsp.stage}; only a live TSP issues MIDs.`
    : !flows.length ? "The TSP may not issue MIDs for any flow yet."
    : null;

  const m = useMutation({
    mutationFn: () => call<{ id: string; request_id: string }>(`/api/merchants/${merchantId}/issued-mids`, {
      method: "POST",
      body: JSON.stringify({
        flow, mid_value: value.trim(), issued_on: issuedOn || undefined, expires_on: expiresOn || undefined,
        daily_limit: daily || undefined, monthly_limit: monthly || undefined,
      }),
    }),
    onSuccess: () => {
      toast.success("MID recorded", {
        description: <span>It waits for a second Super Admin on <Link href="/admin/maker-checker" className="underline">Maker-Checker</Link>.</span>,
      });
      setValue(""); setIssuedOn(""); setExpiresOn(""); setDaily(""); setMonthly("");
      onDone();
    },
    onError: (e: Error) => toast.error("Could not record the MID", { description: e.message }),
  });

  const dis = !!blocked;
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center gap-2 text-sm font-medium"><Plus className="h-4 w-4" /> Record a MID</div>
      {blocked && <p className={`text-xs ${muted}`}>{blocked}</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="mid-flow">Flow</Label>
          <select id="mid-flow" className={selectCls} value={flow} onChange={(e) => setFlow(e.target.value)} disabled={dis}>
            {flows.map((f) => <option key={f} value={f}>{FLOW_LABEL[f]}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mid-value">MID</Label>
          <Input id="mid-value" value={value} onChange={(e) => setValue(e.target.value)} disabled={dis} placeholder="As issued by the bank" autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mid-issued">Issued on</Label>
          <Input id="mid-issued" type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} disabled={dis} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mid-expires">Expires on</Label>
          <Input id="mid-expires" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} disabled={dis} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mid-daily">Daily limit (₹)</Label>
          <Input id="mid-daily" type="number" min="0" step="0.01" value={daily} onChange={(e) => setDaily(e.target.value)} disabled={dis} placeholder="Optional" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mid-monthly">Monthly limit (₹)</Label>
          <Input id="mid-monthly" type="number" min="0" step="0.01" value={monthly} onChange={(e) => setMonthly(e.target.value)} disabled={dis} placeholder="Optional" />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => m.mutate()} disabled={dis || !flow || value.trim().length < 4 || m.isPending}>
          {m.isPending ? "Recording…" : "Record MID"}
        </Button>
        <span className={`text-xs ${muted}`}>Saved as waiting for approval; a second Super Admin makes it active.</span>
      </div>
    </div>
  );
}

// ── History ─────────────────────────────────────────────────────────────────────────────────

function HistoryCard({ chain }: { chain: BankerChain }) {
  const byId = useMemo(() => new Map(chain.mids.map((m) => [m.id, m])), [chain.mids]);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><History className="h-4 w-4" /> History</CardTitle>
        <CardDescription>Every status change of this banker&apos;s MIDs, newest first (IST).</CardDescription>
      </CardHeader>
      <CardContent>
        {chain.events.length === 0 ? (
          <p className={`text-sm ${muted}`}>Nothing yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {chain.events.map((e, i) => {
              const mid = byId.get(e.mid_id);
              return (
                <li key={`${e.mid_id}-${e.at}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b pb-2 last:border-0">
                  <span className="text-xs tabular-nums text-[color:var(--color-text-muted)]">{formatDateTime(e.at)}</span>
                  <span>
                    {mid ? <>{FLOW_LABEL[mid.flow]} <span className="font-mono text-xs">{maskMid(mid.mid_value)}</span></> : "MID"}:{" "}
                    {statusLabel(e.from_status)} → <strong className="font-medium">{statusLabel(e.to_status)}</strong>
                  </span>
                  <span className={`text-xs ${muted}`}>by {e.actor ?? "system"}</span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
