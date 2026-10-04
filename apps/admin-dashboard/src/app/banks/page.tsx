"use client";

// The bank master: banks that issue MIDs, and how many TSPs each has confirmed (lib/chain). Staff only.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Landmark, Pencil, Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BANK_TYPES } from "@/lib/chain";

interface BankRow {
  id: string; code: string; name: string; bank_type: string; settlement_account: string | null;
  neft_enabled: boolean; imps_enabled: boolean; upi_enabled: boolean; contact_email: string | null; status: "ACTIVE" | "INACTIVE";
  tsps: number; bankers: number;
}

const TYPE_LABEL: Record<string, string> = {
  PUBLIC: "Public sector", PRIVATE: "Private", COOPERATIVE: "Co-operative", FOREIGN: "Foreign",
  SMALL_FINANCE: "Small finance", PAYMENTS: "Payments bank",
};
const selectCls = "flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]";

async function readJson<T>(r: Response): Promise<T> {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
  return d as T;
}

type Form = {
  code: string; name: string; bank_type: string; settlement_account: string; contact_email: string;
  neft_enabled: boolean; imps_enabled: boolean; upi_enabled: boolean; status: "ACTIVE" | "INACTIVE";
};
const EMPTY: Form = { code: "", name: "", bank_type: "PRIVATE", settlement_account: "", contact_email: "", neft_enabled: true, imps_enabled: true, upi_enabled: true, status: "ACTIVE" };

/** New bank (no `bank`) or edit one. The settlement account is shown masked, so it is sent only when typed again. */
function BankDialog({ bank, open, onOpenChange }: { bank: BankRow | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const editing = !!bank;
  const [f, setF] = useState<Form>(() => bank ? {
    code: bank.code, name: bank.name, bank_type: bank.bank_type, settlement_account: "", contact_email: bank.contact_email ?? "",
    neft_enabled: bank.neft_enabled, imps_enabled: bank.imps_enabled, upi_enabled: bank.upi_enabled, status: bank.status,
  } : EMPTY);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  const m = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: f.name.trim(), bank_type: f.bank_type, contact_email: f.contact_email.trim() || null,
        neft_enabled: f.neft_enabled, imps_enabled: f.imps_enabled, upi_enabled: f.upi_enabled,
      };
      if (f.settlement_account.trim()) body.settlement_account = f.settlement_account.replace(/\s/g, "");
      if (editing) body.status = f.status;
      else body.code = f.code.trim().toUpperCase();
      return readJson(await fetch(editing ? `/api/banks/${bank!.id}` : "/api/banks", {
        method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }));
    },
    onSuccess: () => {
      toast.success(editing ? "Bank saved" : `Bank ${f.code.toUpperCase()} added`);
      qc.invalidateQueries({ queryKey: ["banks"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(editing ? "Could not save" : "Could not add the bank", { description: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${bank!.code}` : "New bank"}</DialogTitle>
          <DialogDescription>{editing ? "Change its details, rails or status." : "A bank that issues MIDs to bankers through a TSP."}</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            {!editing && (
              <div className="space-y-1.5">
                <Label htmlFor="b-code">Code</Label>
                <Input id="b-code" value={f.code} onChange={(e) => set("code", e.target.value.toUpperCase())} placeholder="e.g. HDFC" maxLength={20} required />
              </div>
            )}
            <div className={editing ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
              <Label htmlFor="b-name">Name</Label>
              <Input id="b-name" value={f.name} onChange={(e) => set("name", e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="b-type">Type</Label>
              <select id="b-type" className={selectCls} value={f.bank_type} onChange={(e) => set("bank_type", e.target.value)}>
                {BANK_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>)}
              </select>
            </div>
            {editing && (
              <div className="space-y-1.5">
                <Label htmlFor="b-status">Status</Label>
                <select id="b-status" className={selectCls} value={f.status} onChange={(e) => set("status", e.target.value as Form["status"])}>
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                </select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="b-acct">Settlement account</Label>
              <Input id="b-acct" inputMode="numeric" value={f.settlement_account} onChange={(e) => set("settlement_account", e.target.value)}
                placeholder={editing ? (bank!.settlement_account ? `${bank!.settlement_account} (type to replace)` : "6–20 digits") : "6–20 digits"} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="b-email">Contact email</Label>
              <Input id="b-email" type="email" value={f.contact_email} onChange={(e) => set("contact_email", e.target.value)} />
            </div>
          </div>
          <div>
            <div className="mb-2 text-sm font-medium">Rails</div>
            <div className="flex flex-wrap gap-4">
              {([["neft_enabled", "NEFT"], ["imps_enabled", "IMPS"], ["upi_enabled", "UPI"]] as const).map(([k, label]) => (
                <label key={k} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={f[k]} onChange={(e) => set(k, e.target.checked)} /> {label}
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={m.isPending || !f.name.trim() || (!editing && !f.code.trim())}>
              {m.isPending ? "Saving…" : editing ? "Save" : "Add bank"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function BanksPage() {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<BankRow | null>(null);
  const q = useQuery({ queryKey: ["banks"], queryFn: async () => (await readJson<{ banks: BankRow[] }>(await fetch("/api/banks"))).banks });

  const columns: Column<BankRow>[] = [
    { key: "code", header: "Code", render: (b) => <span className="font-mono font-medium">{b.code}</span> },
    { key: "name", header: "Name" },
    { key: "bank_type", header: "Type", render: (b) => TYPE_LABEL[b.bank_type] ?? b.bank_type },
    { key: "rails", header: "Rails", render: (b) => (
      <div className="flex flex-wrap gap-1">
        {b.neft_enabled && <Badge variant="info">NEFT</Badge>}
        {b.imps_enabled && <Badge variant="info">IMPS</Badge>}
        {b.upi_enabled && <Badge variant="info">UPI</Badge>}
        {!b.neft_enabled && !b.imps_enabled && !b.upi_enabled && <span className="text-xs text-[color:var(--color-text-muted)]">None</span>}
      </div>
    ) },
    { key: "settlement_account", header: "Settlement account", render: (b) => b.settlement_account
      ? <span className="font-mono text-xs">{b.settlement_account}</span> : <span className="text-[color:var(--color-text-muted)]">—</span> },
    { key: "tsps", header: "TSPs", className: "text-right tabular-nums" },
    { key: "bankers", header: "Bankers", className: "text-right tabular-nums" },
    { key: "status", header: "Status", render: (b) => <Badge variant={b.status === "ACTIVE" ? "success" : "default"}>{b.status === "ACTIVE" ? "Active" : "Inactive"}</Badge> },
    { key: "edit", header: "", className: "text-right", render: (b) => (
      <Button size="sm" variant="ghost" onClick={() => setEditing(b)} aria-label={`Edit ${b.code}`}><Pencil className="h-4 w-4" /> Edit</Button>
    ) },
  ];

  return (
    <div>
      <PageHeader title="Banks" icon={Landmark} description="Banks that issue MIDs, and the TSPs each has confirmed."
        actions={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New bank</Button>} />
      <Card>
        <CardContent className="pt-6">
          {q.error ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p> : (
            <DataTable columns={columns} rows={q.data ?? []} loading={q.isLoading} rowKey={(b) => b.id}
              emptyState={<>No banks yet. Add the banks that issue MIDs with &quot;New bank&quot;.</>} />
          )}
        </CardContent>
      </Card>
      {creating && <BankDialog bank={null} open onOpenChange={setCreating} />}
      {editing && <BankDialog key={editing.id} bank={editing} open onOpenChange={(v) => { if (!v) setEditing(null); }} />}
    </div>
  );
}
