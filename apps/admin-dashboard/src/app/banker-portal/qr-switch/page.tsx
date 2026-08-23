"use client";

// Banker QR switch (QR BRD modules 01 + 05).
//
// The screen answers one question and offers one action: which stores am I collecting for,
// and move this one onto a different QR of mine. The switch executes on click — there is no
// approval queue in this phase — so the confirm step spells out both endpoints in full
// rather than asking "are you sure?" about an id the banker cannot read.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QrCode, Repeat, Plus, Store } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { formatDateTime, statusVariant } from "@/lib/utils";

const PROVIDERS = ["GOOGLE_PAY", "PHONEPE", "PAYTM", "MOBIKWIK", "OTHER"] as const;
const PROVIDER_LABEL: Record<string, string> = {
  GOOGLE_PAY: "Google Pay", PHONEPE: "PhonePe", PAYTM: "Paytm", MOBIKWIK: "MobiKwik", OTHER: "Other",
};

interface StoreRow {
  store_id: string; store_code: string; store_name: string; city: string | null;
  merchant_name: string; qr_id: string | null; qr_upi_id: string | null;
  qr_provider: string | null; assigned_at: string | null;
}
interface Qr {
  id: string; provider: string; upi_id: string; settlement_type: string;
  daily_limit: number | null; remarks: string | null;
  approval_status: string; routing_status: string; created_at: string;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
  return d as T;
}

export default function BankerQrSwitchPage() {
  const qc = useQueryClient();
  const [target, setTarget] = useState<StoreRow | null>(null);
  const [chosenQr, setChosenQr] = useState<string>("");
  const [reason, setReason] = useState("");
  const [addOpen, setAddOpen] = useState(false);

  const switchQ = useQuery({
    queryKey: ["bp:qr-switch"],
    queryFn: () => getJson<{ banker_code: string; stores: StoreRow[]; available_qrs: Qr[] }>("/api/banker-portal/qr-switch"),
  });
  const poolQ = useQuery({
    queryKey: ["bp:qr-pool"],
    queryFn: () => getJson<{ qrs: Qr[] }>("/api/banker-portal/qr"),
  });

  const stores = switchQ.data?.stores ?? [];
  const available = switchQ.data?.available_qrs ?? [];

  const doSwitch = useMutation({
    mutationFn: async () => {
      if (!target || !chosenQr) throw new Error("pick a QR to switch to");
      const r = await fetch("/api/banker-portal/qr-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          store_id: target.store_id,
          to_qr_id: chosenQr,
          reason: reason || undefined,
          // Guards a double-click and a retried request: the second one returns the first
          // switch instead of performing another.
          idempotency_key: `${target.store_id}:${chosenQr}:${target.qr_id ?? "none"}`,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d as { replayed: boolean };
    },
    onSuccess: (d) => {
      toast.success(d.replayed ? "Already switched — nothing changed" : `${target?.store_name} switched`);
      setTarget(null); setChosenQr(""); setReason("");
      qc.invalidateQueries({ queryKey: ["bp:qr-switch"] });
      qc.invalidateQueries({ queryKey: ["bp:qr-pool"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const addQr = useMutation({
    mutationFn: async (fd: FormData) => {
      const r = await fetch("/api/banker-portal/qr", { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d;
    },
    onSuccess: () => {
      toast.success("QR added — an admin has to approve it before you can switch to it");
      setAddOpen(false);
      qc.invalidateQueries({ queryKey: ["bp:qr-pool"] });
      qc.invalidateQueries({ queryKey: ["bp:qr-switch"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const storeCols: Column<StoreRow>[] = [
    { key: "merchant_name", header: "Merchant", render: (r) => r.merchant_name },
    {
      key: "store_name", header: "Store",
      render: (r) => (
        <div>
          <div>{r.store_name}</div>
          <div className="text-xs text-muted-foreground font-mono">{r.store_code}{r.city ? ` · ${r.city}` : ""}</div>
        </div>
      ),
    },
    {
      key: "qr_upi_id", header: "Collecting on",
      render: (r) => (
        <div>
          <div className="font-mono text-xs">{r.qr_upi_id ?? "—"}</div>
          <div className="text-xs text-muted-foreground">{r.qr_provider ? PROVIDER_LABEL[r.qr_provider] : ""}</div>
        </div>
      ),
    },
    { key: "assigned_at", header: "Since", render: (r) => (r.assigned_at ? formatDateTime(r.assigned_at) : "—") },
    {
      key: "store_id", header: "",
      render: (r) => (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => { setTarget(r); setChosenQr(""); setReason(""); }}
          disabled={!available.length}
          title={available.length ? "Move this store to another of your QRs" : "No free approved QR to switch to"}
        >
          <Repeat className="mr-1.5 h-3.5 w-3.5" />Switch QR
        </Button>
      ),
    },
  ];

  const poolCols: Column<Qr>[] = [
    { key: "upi_id", header: "UPI ID", render: (r) => <span className="font-mono text-xs">{r.upi_id}</span> },
    { key: "provider", header: "App", render: (r) => PROVIDER_LABEL[r.provider] ?? r.provider },
    { key: "settlement_type", header: "Settlement", render: (r) => r.settlement_type },
    { key: "daily_limit", header: "Daily limit", render: (r) => (r.daily_limit ? r.daily_limit.toLocaleString("en-IN") : "—") },
    { key: "approval_status", header: "Approval", render: (r) => <Badge variant={statusVariant(r.approval_status)}>{r.approval_status}</Badge> },
    { key: "routing_status", header: "Routing", render: (r) => <Badge variant={statusVariant(r.routing_status)}>{r.routing_status}</Badge> },
  ];

  return (
    <>
      <PageHeader
        title="QR switch"
        description="Move a store onto another of your QRs. The change is immediate."
        icon={QrCode}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-4">
        <Card><CardHeader><CardDescription>Stores you collect for</CardDescription><CardTitle className="text-2xl">{stores.length}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>QRs free to switch to</CardDescription><CardTitle className="text-2xl">{available.length}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Awaiting approval</CardDescription><CardTitle className="text-2xl">
          {(poolQ.data?.qrs ?? []).filter((q) => q.approval_status === "PENDING").length}
        </CardTitle></CardHeader></Card>
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Store className="h-4 w-4" />{stores.length} stores</CardTitle>
          <CardDescription>Only stores your QRs are currently live on appear here.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={storeCols}
            rows={stores}
            loading={switchQ.isLoading}
            rowKey={(r) => r.store_id}
            emptyState="No stores are on your QRs yet. An admin allocates the first QR to a store."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Your QRs</CardTitle>
            <CardDescription>A QR must be approved and free before a store can move onto it.</CardDescription>
          </div>
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="mr-1.5 h-3.5 w-3.5" />Add QR</Button>
            </DialogTrigger>
            <DialogContent>
              <form
                onSubmit={(e) => { e.preventDefault(); addQr.mutate(new FormData(e.currentTarget)); }}
              >
                <DialogHeader>
                  <DialogTitle>Add a QR</DialogTitle>
                  <DialogDescription>
                    It goes into your pool as pending. An admin approves it before any store can be switched onto it.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-3 py-4">
                  <div className="grid gap-1.5">
                    <Label htmlFor="upi_id">UPI ID</Label>
                    <Input id="upi_id" name="upi_id" placeholder="name@okbizaxis" required />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="provider">Payment app</Label>
                    <select id="provider" name="provider" required
                      className="h-9 rounded-md border border-input bg-transparent px-3 text-sm">
                      {PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
                    </select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="settlement_type">Settlement</Label>
                    <select id="settlement_type" name="settlement_type"
                      className="h-9 rounded-md border border-input bg-transparent px-3 text-sm">
                      <option value="INSTANT">Instant</option>
                      <option value="T1">T+1</option>
                      <option value="MANUAL">Manual</option>
                    </select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="daily_limit">Daily limit (optional)</Label>
                    <Input id="daily_limit" name="daily_limit" type="number" min="0" step="1" placeholder="e.g. 100000" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="image">QR image (optional)</Label>
                    <Input id="image" name="image" type="file" accept="image/png,image/jpeg,image/webp" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="remarks">Remarks (optional)</Label>
                    <Input id="remarks" name="remarks" placeholder="Which counter / which account" />
                  </div>
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={addQr.isPending}>
                    {addQr.isPending ? "Adding…" : "Add QR"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={poolCols}
            rows={poolQ.data?.qrs ?? []}
            loading={poolQ.isLoading}
            rowKey={(r) => r.id}
            emptyState="No QRs yet. Add the UPI IDs you collect on."
          />
        </CardContent>
      </Card>

      {/* Confirm step. Both endpoints are spelled out because a VPA is the only part of this
          the banker can actually verify against the phone in their hand. */}
      <Dialog open={!!target} onOpenChange={(o) => { if (!o) setTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch {target?.store_name}</DialogTitle>
            <DialogDescription>
              This store stops collecting on{" "}
              <span className="font-mono">{target?.qr_upi_id ?? "—"}</span> and starts collecting on the QR you pick.
              It takes effect immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <div className="grid gap-1.5">
              <Label htmlFor="to_qr">Switch to</Label>
              <select
                id="to_qr" value={chosenQr} onChange={(e) => setChosenQr(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="">Choose a QR…</option>
                {available.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.upi_id} · {PROVIDER_LABEL[q.provider] ?? q.provider}
                    {q.daily_limit ? ` · limit ${q.daily_limit.toLocaleString("en-IN")}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="reason">Reason (optional)</Label>
              <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="QR not scanning / limit reached / settlement delayed" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setTarget(null)}>Cancel</Button>
            <Button onClick={() => doSwitch.mutate()} disabled={!chosenQr || doSwitch.isPending}>
              {doSwitch.isPending ? "Switching…" : "Switch now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
