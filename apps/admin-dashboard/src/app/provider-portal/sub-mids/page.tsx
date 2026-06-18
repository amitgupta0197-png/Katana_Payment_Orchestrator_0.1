"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface SubMid {
  id: string; sub_mid_code: string; traffic_mode: string; kyc_status: string;
  settlement_enabled: boolean; merchant_id: string; main_mid_code: string; requested_at: string;
}
interface MainMid { id: string; mid_code: string; merchant_id: string; }
interface Merchant { id: string; merchant_code: string; legal_name: string; stage: string }

function RequestDialog({ mains, merchants }: { mains: MainMid[]; merchants: Merchant[] }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    main_mid_code: mains[0]?.mid_code ?? "",
    merchant_id: merchants[0]?.id ?? "",
    sub_mid_code: "SUB-NEW",
    traffic_mode: "TRAFFIC" as "TRAFFIC" | "KYC_APPROVED",
  });

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/sub-mids", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "create_sub_mid", ...form }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Sub-MID requested"); setOpen(false); qc.invalidateQueries({ queryKey: ["pp:sub-mids"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus /> Request Sub-MID</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request Sub-MID</DialogTitle>
          <DialogDescription>TRAFFIC starts immediately; KYC_APPROVED requires merchant kyc_status=APPROVED first.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5 col-span-2">
            <Label>merchant</Label>
            <select
              className="flex h-9 w-full rounded-md border px-3 py-1 text-sm"
              value={form.merchant_id}
              onChange={(e) => setForm({ ...form, merchant_id: e.target.value })}
            >
              {merchants.map((m) => (
                <option key={m.id} value={m.id}>{m.merchant_code} — {m.legal_name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>main MID</Label>
            <select
              className="flex h-9 w-full rounded-md border px-3 py-1 text-sm"
              value={form.main_mid_code}
              onChange={(e) => setForm({ ...form, main_mid_code: e.target.value })}
            >
              {mains.map((m) => (<option key={m.id} value={m.mid_code}>{m.mid_code}</option>))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>sub-MID code</Label>
            <Input value={form.sub_mid_code} onChange={(e) => setForm({ ...form, sub_mid_code: e.target.value })} />
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>traffic mode</Label>
            <select
              className="flex h-9 w-full rounded-md border px-3 py-1 text-sm"
              value={form.traffic_mode}
              onChange={(e) => setForm({ ...form, traffic_mode: e.target.value as "TRAFFIC" | "KYC_APPROVED" })}
            >
              <option value="TRAFFIC">TRAFFIC</option>
              <option value="KYC_APPROVED">KYC_APPROVED</option>
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Requesting…" : "Request"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SubMidsPage() {
  const q = useQuery({
    queryKey: ["pp:sub-mids"],
    queryFn: async () => (await fetch("/api/sub-mids").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { sub_mids: SubMid[]; main_mids: MainMid[] },
  });
  const merchants = useQuery({
    queryKey: ["pp:merchants"],
    queryFn: async () => (await fetch("/api/merchants").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { merchants: Merchant[] },
  });

  const cols: Column<SubMid>[] = [
    { key: "sub_mid_code", header: "Code" },
    { key: "main_mid_code", header: "Main MID" },
    { key: "traffic_mode", header: "Mode", render: (r) => <Badge variant={statusVariant(r.traffic_mode)}>{r.traffic_mode}</Badge> },
    { key: "kyc_status", header: "KYC", render: (r) => <Badge variant={statusVariant(r.kyc_status)}>{r.kyc_status}</Badge> },
    { key: "settlement_enabled", header: "Settle?", render: (r) => r.settlement_enabled ? <Badge variant="success">on</Badge> : <Badge variant="default">off</Badge> },
    { key: "requested_at", header: "Requested", render: (r) => formatDateTime(r.requested_at) },
  ];

  return (
    <>
      <PageHeader
        title="Sub-MIDs"
        description="Sub-MIDs across your mapped merchants. Request new ones here; Super Admin approves."
        icon={CreditCard}
        actions={<RequestDialog mains={q.data?.main_mids ?? []} merchants={merchants.data?.merchants ?? []} />}
      />
      <Card>
        <CardHeader><CardTitle>{(q.data?.sub_mids ?? []).length} Sub-MIDs</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={q.data?.sub_mids ?? []}
            loading={q.isLoading}
            rowKey={(r) => r.id}
            emptyState="No Sub-MIDs yet. Request one above to begin."
          />
        </CardContent>
      </Card>
    </>
  );
}
