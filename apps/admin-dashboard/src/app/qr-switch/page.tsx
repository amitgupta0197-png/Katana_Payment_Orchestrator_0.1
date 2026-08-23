"use client";

// Admin QR operations (QR BRD modules 01 + 02).
//
// Two jobs live here, because they are the two things only an admin can do:
//   QR inventory — approve, reject, pause the QRs bankers upload.
//   Stores       — create a merchant's stores and allocate the FIRST QR to one.
//
// Once a store has an endpoint, the banker moves it themselves from /banker-portal/qr-switch;
// admin allocation exists for the initial hand-off, not for day-to-day switching.
//
// NAMING (middleware.ts:103-105): "Merchant" is a row in `providers`; "Banker" is a row in
// `merchants`, keyed by merchant_code. The nav uses the same words.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QrCode, Check, X, Pause, Play, Plus, Link2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { formatDateTime, statusVariant } from "@/lib/utils";

const PROVIDER_LABEL: Record<string, string> = {
  GOOGLE_PAY: "Google Pay", PHONEPE: "PhonePe", PAYTM: "Paytm", MOBIKWIK: "MobiKwik", OTHER: "Other",
};

interface AdminQr {
  id: string; banker_code: string; provider: string; upi_id: string; settlement_type: string;
  daily_limit: number | null; remarks: string | null; approval_status: string; routing_status: string;
  rejection_reason: string | null; created_by: string | null; created_at: string;
  live_store_code: string | null; live_merchant_name: string | null;
}
interface AdminStore {
  store_id: string; store_code: string; store_name: string; city: string | null;
  provider_id: string; merchant_name: string; qr_id: string | null; qr_upi_id: string | null;
  qr_provider: string | null; banker_code: string | null; assigned_at: string | null;
  switch_count: number; status: string;
}
interface Candidate {
  id: string; banker_code: string; provider: string; upi_id: string; daily_limit: number | null;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
  return d as T;
}
async function send(url: string, method: string, body: unknown) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d;
}

export default function AdminQrSwitchPage() {
  const qc = useQueryClient();
  const [allocTarget, setAllocTarget] = useState<AdminStore | null>(null);
  const [chosenQr, setChosenQr] = useState("");
  const [storeOpen, setStoreOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  const qrsQ = useQuery({ queryKey: ["adm:qrs"], queryFn: () => getJson<{ qrs: AdminQr[] }>("/api/qr") });
  const storesQ = useQuery({ queryKey: ["adm:stores"], queryFn: () => getJson<{ stores: AdminStore[] }>("/api/stores") });
  const merchantsQ = useQuery({
    queryKey: ["adm:providers"],
    queryFn: () => getJson<{ providers: { id: string; legal_name: string; code: string }[] }>("/api/providers"),
  });
  // Candidates depend on the store's current banker, so they are fetched per store when the
  // allocate dialog opens rather than listed up front.
  const candQ = useQuery({
    queryKey: ["adm:cand", allocTarget?.store_id],
    enabled: !!allocTarget,
    queryFn: () => getJson<{ candidates: Candidate[]; current_banker_code: string | null }>(
      `/api/stores/${allocTarget!.store_id}/assignment`),
  });

  const act = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: string; reason?: string }) =>
      send(`/api/qr/${id}`, "PATCH", { action, reason }),
    onSuccess: (_d, v) => { toast.success(`QR ${v.action}d`); qc.invalidateQueries({ queryKey: ["adm:qrs"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const allocate = useMutation({
    mutationFn: () => send(`/api/stores/${allocTarget!.store_id}/assignment`, "POST", {
      to_qr_id: chosenQr,
      idempotency_key: `${allocTarget!.store_id}:${chosenQr}:${allocTarget!.qr_id ?? "none"}`,
    }),
    onSuccess: () => {
      toast.success(`${allocTarget?.store_name} allocated`);
      setAllocTarget(null); setChosenQr("");
      qc.invalidateQueries({ queryKey: ["adm:stores"] });
      qc.invalidateQueries({ queryKey: ["adm:qrs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createStore = useMutation({
    mutationFn: (body: Record<string, string>) => send("/api/stores", "POST", body),
    onSuccess: () => { toast.success("Store created"); setStoreOpen(false); qc.invalidateQueries({ queryKey: ["adm:stores"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const createQr = useMutation({
    mutationFn: async (fd: FormData) => {
      const r = await fetch("/api/qr", { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d;
    },
    onSuccess: () => { toast.success("QR added and approved"); setQrOpen(false); qc.invalidateQueries({ queryKey: ["adm:qrs"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const qrs = qrsQ.data?.qrs ?? [];
  const pending = qrs.filter((q) => q.approval_status === "PENDING");

  const qrCols: Column<AdminQr>[] = [
    { key: "banker_code", header: "Banker", render: (r) => <span className="font-mono text-xs">{r.banker_code}</span> },
    { key: "upi_id", header: "UPI ID", render: (r) => <span className="font-mono text-xs">{r.upi_id}</span> },
    { key: "provider", header: "App", render: (r) => PROVIDER_LABEL[r.provider] ?? r.provider },
    {
      key: "live_store_code", header: "Live on",
      render: (r) => (r.live_store_code
        ? <div><div className="text-xs">{r.live_merchant_name}</div><div className="font-mono text-xs text-muted-foreground">{r.live_store_code}</div></div>
        : <span className="text-muted-foreground">—</span>),
    },
    { key: "approval_status", header: "Approval", render: (r) => <Badge variant={statusVariant(r.approval_status)}>{r.approval_status}</Badge> },
    { key: "routing_status", header: "Routing", render: (r) => <Badge variant={statusVariant(r.routing_status)}>{r.routing_status}</Badge> },
    { key: "created_at", header: "Added", render: (r) => formatDateTime(r.created_at) },
    {
      key: "id", header: "",
      render: (r) => (
        <div className="flex gap-1.5">
          {r.approval_status === "PENDING" && (
            <>
              <Button size="sm" onClick={() => act.mutate({ id: r.id, action: "approve" })}>
                <Check className="mr-1 h-3.5 w-3.5" />Approve
              </Button>
              <Button size="sm" variant="danger" onClick={() => {
                const reason = window.prompt(`Reject ${r.upi_id}? Reason:`);
                if (reason !== null) act.mutate({ id: r.id, action: "reject", reason });
              }}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          {r.approval_status === "APPROVED" && r.routing_status !== "PAUSED" && (
            <Button size="sm" variant="secondary" onClick={() => act.mutate({ id: r.id, action: "pause" })}
              disabled={r.routing_status === "ALLOCATED"}
              title={r.routing_status === "ALLOCATED" ? "Live on a store — switch it away first" : "Take out of the switch pool"}>
              <Pause className="h-3.5 w-3.5" />
            </Button>
          )}
          {r.routing_status === "PAUSED" && (
            <Button size="sm" variant="secondary" onClick={() => act.mutate({ id: r.id, action: "resume" })}>
              <Play className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  const storeCols: Column<AdminStore>[] = [
    { key: "merchant_name", header: "Merchant", render: (r) => r.merchant_name },
    {
      key: "store_name", header: "Store",
      render: (r) => (
        <div><div>{r.store_name}</div>
          <div className="font-mono text-xs text-muted-foreground">{r.store_code}{r.city ? ` · ${r.city}` : ""}</div></div>
      ),
    },
    {
      key: "qr_upi_id", header: "Live endpoint",
      render: (r) => (r.qr_upi_id
        ? <div><div className="font-mono text-xs">{r.qr_upi_id}</div>
            <div className="text-xs text-muted-foreground">{r.banker_code} · {r.qr_provider ? PROVIDER_LABEL[r.qr_provider] : ""}</div></div>
        : <Badge variant="danger">Not allocated</Badge>),
    },
    { key: "switch_count", header: "Switches", render: (r) => r.switch_count },
    { key: "assigned_at", header: "Since", render: (r) => (r.assigned_at ? formatDateTime(r.assigned_at) : "—") },
    {
      key: "store_id", header: "",
      render: (r) => (
        <Button size="sm" variant="secondary" onClick={() => { setAllocTarget(r); setChosenQr(""); }}>
          <Link2 className="mr-1.5 h-3.5 w-3.5" />{r.qr_id ? "Reallocate" : "Allocate QR"}
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="QR operations" description="Approve banker QR inventory and allocate store endpoints." icon={QrCode} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-4">
        <Card><CardHeader><CardDescription>QRs in inventory</CardDescription><CardTitle className="text-2xl">{qrs.length}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Awaiting approval</CardDescription><CardTitle className="text-2xl">{pending.length}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Stores without an endpoint</CardDescription><CardTitle className="text-2xl">
          {(storesQ.data?.stores ?? []).filter((s) => !s.qr_id).length}
        </CardTitle></CardHeader></Card>
      </div>

      <Tabs defaultValue="qrs">
        <TabsList>
          <TabsTrigger value="qrs">QR inventory</TabsTrigger>
          <TabsTrigger value="stores">Stores</TabsTrigger>
        </TabsList>

        <TabsContent value="qrs">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>{qrs.length} QRs</CardTitle>
                <CardDescription>Pending first. Only approved, unpaused, unallocated QRs are switch candidates.</CardDescription>
              </div>
              <Dialog open={qrOpen} onOpenChange={setQrOpen}>
                <DialogTrigger asChild><Button size="sm"><Plus className="mr-1.5 h-3.5 w-3.5" />Add QR</Button></DialogTrigger>
                <DialogContent>
                  <form onSubmit={(e) => { e.preventDefault(); createQr.mutate(new FormData(e.currentTarget)); }}>
                    <DialogHeader>
                      <DialogTitle>Add a QR for a banker</DialogTitle>
                      <DialogDescription>Approved immediately — you are the approval authority.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-3 py-4">
                      <div className="grid gap-1.5">
                        <Label htmlFor="banker_code">Banker code</Label>
                        <Input id="banker_code" name="banker_code" placeholder="e.g. PRIMESX" required />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="a_upi">UPI ID</Label>
                        <Input id="a_upi" name="upi_id" placeholder="name@okbizaxis" required />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="a_provider">Payment app</Label>
                        <select id="a_provider" name="provider" required className="h-9 rounded-md border border-input bg-transparent px-3 text-sm">
                          {Object.entries(PROVIDER_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="a_settle">Settlement</Label>
                        <select id="a_settle" name="settlement_type" className="h-9 rounded-md border border-input bg-transparent px-3 text-sm">
                          <option value="INSTANT">Instant</option><option value="T1">T+1</option><option value="MANUAL">Manual</option>
                        </select>
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="a_limit">Daily limit (optional)</Label>
                        <Input id="a_limit" name="daily_limit" type="number" min="0" />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="a_img">QR image (optional)</Label>
                        <Input id="a_img" name="image" type="file" accept="image/png,image/jpeg,image/webp" />
                      </div>
                    </div>
                    <DialogFooter><Button type="submit" disabled={createQr.isPending}>{createQr.isPending ? "Adding…" : "Add QR"}</Button></DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </CardHeader>
            <CardContent>
              <DataTable columns={qrCols} rows={qrs} loading={qrsQ.isLoading} rowKey={(r) => r.id}
                emptyState="No QRs yet. Bankers add their own, or add one here." />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="stores">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>{(storesQ.data?.stores ?? []).length} stores</CardTitle>
                <CardDescription>A store collects on exactly one QR at a time.</CardDescription>
              </div>
              <Dialog open={storeOpen} onOpenChange={setStoreOpen}>
                <DialogTrigger asChild><Button size="sm"><Plus className="mr-1.5 h-3.5 w-3.5" />New store</Button></DialogTrigger>
                <DialogContent>
                  <form onSubmit={(e) => {
                    e.preventDefault();
                    const fd = new FormData(e.currentTarget);
                    createStore.mutate(Object.fromEntries(fd) as Record<string, string>);
                  }}>
                    <DialogHeader>
                      <DialogTitle>New store</DialogTitle>
                      <DialogDescription>Stores belong to a merchant. Allocate its QR after creating it.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-3 py-4">
                      <div className="grid gap-1.5">
                        <Label htmlFor="provider_id">Merchant</Label>
                        <select id="provider_id" name="provider_id" required className="h-9 rounded-md border border-input bg-transparent px-3 text-sm">
                          <option value="">Choose…</option>
                          {(merchantsQ.data?.providers ?? []).map((p) => (
                            <option key={p.id} value={p.id}>{p.legal_name} ({p.code})</option>
                          ))}
                        </select>
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="code">Store code</Label>
                        <Input id="code" name="code" placeholder="S001" required />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="name">Store name</Label>
                        <Input id="name" name="name" placeholder="Mumbai Store 01" required />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="city">City (optional)</Label>
                        <Input id="city" name="city" />
                      </div>
                    </div>
                    <DialogFooter><Button type="submit" disabled={createStore.isPending}>{createStore.isPending ? "Creating…" : "Create store"}</Button></DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </CardHeader>
            <CardContent>
              <DataTable columns={storeCols} rows={storesQ.data?.stores ?? []} loading={storesQ.isLoading}
                rowKey={(r) => r.store_id} emptyState="No stores yet." />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={!!allocTarget} onOpenChange={(o) => { if (!o) setAllocTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{allocTarget?.qr_id ? "Reallocate" : "Allocate"} {allocTarget?.store_name}</DialogTitle>
            <DialogDescription>
              {allocTarget?.qr_id
                ? <>Currently on <span className="font-mono">{allocTarget.qr_upi_id}</span>. Only QRs from the same banker ({allocTarget.banker_code}) are offered — cross-banker failover is not built yet.</>
                : <>First allocation: any approved, free QR is eligible, and the banker that owns it becomes this store&apos;s banker.</>}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <Label htmlFor="cand">QR</Label>
            <select id="cand" value={chosenQr} onChange={(e) => setChosenQr(e.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm">
              <option value="">{candQ.isLoading ? "Loading…" : "Choose a QR…"}</option>
              {(candQ.data?.candidates ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.banker_code} · {c.upi_id} · {PROVIDER_LABEL[c.provider] ?? c.provider}</option>
              ))}
            </select>
            {candQ.data && !candQ.data.candidates.length && (
              <p className="text-xs text-muted-foreground">No eligible QR. Approve one, or free one that is live on another store.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setAllocTarget(null)}>Cancel</Button>
            <Button onClick={() => allocate.mutate()} disabled={!chosenQr || allocate.isPending}>
              {allocate.isPending ? "Allocating…" : "Allocate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
