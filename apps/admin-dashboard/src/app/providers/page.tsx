"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Plus } from "lucide-react";
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
import { useCan } from "@/lib/use-access";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface Provider {
  id: string; code: string; legal_name: string; contact_email: string;
  kind: string; kyc_status: string; status: string; settlement_currency: string;
  user_count: number; doc_count: number; merchant_count: number; created_at: string;
}

function CreateDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    code: "PRV-XXX", legal_name: "New Partner Pvt Ltd",
    contact_email: "ops@partner.example", contact_phone: "9999988888",
    kind: "PROVIDER",
  });
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/providers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Provider created"); qc.invalidateQueries({ queryKey: ["providers"] }); setOpen(false); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus /> Provider</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Create provider</DialogTitle>
          <DialogDescription>Kind: PROVIDER, AGENT, PARTNER, FRANCHISE.</DialogDescription></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {(["code","legal_name","contact_email","contact_phone","kind"] as const).map((k) => (
            <div key={k} className={k === "legal_name" ? "space-y-1.5 col-span-2" : "space-y-1.5"}>
              <Label>{k.replace(/_/g," ")}</Label>
              <Input value={(form as Record<string, string>)[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Creating…" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ProvidersPage() {
  const canCreate = useCan("providers", "create");
  const q = useQuery({
    queryKey: ["providers"],
    queryFn: async () => (await fetch("/api/providers").then((r) => r.json())) as { providers: Provider[] },
  });

  const cols: Column<Provider>[] = [
    {
      key: "code", header: "Code",
      render: (r) => <Link className="text-[color:var(--color-brand)] hover:underline font-medium" href={`/providers/${r.id}`}>{r.code}</Link>,
    },
    {
      key: "legal_name", header: "Legal name",
      render: (r) => <Link className="hover:underline" href={`/providers/${r.id}`}>{r.legal_name}</Link>,
    },
    { key: "kind", header: "Kind" },
    { key: "kyc_status", header: "KYC", render: (r) => <Badge variant={statusVariant(r.kyc_status)}>{r.kyc_status}</Badge> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "merchant_count", header: "Merchants" },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  return (
    <>
      <PageHeader
        title="Providers"
        description="Sub-admin reseller entities and their KYC lifecycle (PRODUCT_VISION §3.1)."
        icon={UserPlus}
        actions={canCreate ? <CreateDialog /> : null}
      />
      <Card>
        <CardHeader><CardTitle>{(q.data?.providers ?? []).length} providers</CardTitle></CardHeader>
        <CardContent>
          <DataTable columns={cols} rows={q.data?.providers ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No providers yet." />
        </CardContent>
      </Card>
    </>
  );
}
