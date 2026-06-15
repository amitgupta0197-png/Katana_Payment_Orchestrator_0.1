"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Plus } from "lucide-react";
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

interface Merchant {
  id: string; merchant_code: string; legal_name: string; brand_name?: string;
  business_type?: string; contact_email: string; stage: string; risk_tier?: string;
  created_at: string;
}

const LEAD_STAGES = new Set(["APPLICATION", "DOCS_PENDING", "IN_REVIEW", "SCREENING"]);

function NewLeadDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    merchant_code: "M-NEW",
    legal_name: "New Merchant Pvt Ltd",
    brand_name: "",
    business_type: "PRIVATE_LIMITED",
    contact_email: "ops@newmerchant.example",
    contact_phone: "9999988888",
    website: "https://newmerchant.example",
  });

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/merchants", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success("Lead created"); setOpen(false);
      qc.invalidateQueries({ queryKey: ["pp:merchants"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus /> New lead</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create merchant lead</DialogTitle>
          <DialogDescription>Per §2.2 step 1. The merchant starts in APPLICATION stage and is auto-mapped to your provider.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {(Object.keys(form) as Array<keyof typeof form>).map((k) => (
            <div key={k} className={k === "legal_name" ? "space-y-1.5 col-span-2" : "space-y-1.5"}>
              <Label>{k.replace(/_/g, " ")}</Label>
              <Input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Creating…" : "Create lead"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function LeadsPage() {
  const q = useQuery({
    queryKey: ["pp:merchants"],
    queryFn: async () => (await fetch("/api/merchants").then((r) => r.json())) as { merchants: Merchant[] },
  });

  const leads = (q.data?.merchants ?? []).filter((m) => LEAD_STAGES.has(m.stage));

  const cols: Column<Merchant>[] = [
    { key: "merchant_code", header: "Code" },
    { key: "legal_name", header: "Legal name" },
    { key: "business_type", header: "Type", render: (r) => r.business_type ?? "—" },
    { key: "contact_email", header: "Contact" },
    {
      key: "stage", header: "Stage",
      render: (r) => <Badge variant={statusVariant(r.stage)}>{r.stage}</Badge>,
    },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  return (
    <>
      <PageHeader
        title="Merchant leads"
        description="Merchants you've sourced that are still in onboarding (APPLICATION → IN_REVIEW). Super Admin approves at /kyb."
        icon={UserPlus}
        actions={<NewLeadDialog />}
      />
      <Card>
        <CardHeader>
          <CardTitle>In flight</CardTitle>
          <CardDescription>{leads.length} leads awaiting decision</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={leads}
            loading={q.isLoading}
            rowKey={(r) => r.id}
            emptyState="No leads in flight. Create one to begin onboarding."
          />
        </CardContent>
      </Card>
    </>
  );
}
