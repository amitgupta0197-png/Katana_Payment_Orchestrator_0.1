"use client";

// L1 — admin/api-keys. DataView w/ owner-kind + status filters, search by
// label / owner / prefix, row kebab (Open / Revoke / Delete). Issue dialog
// lands inline (uses /api/admin/api-keys/issue).

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { KeyRound, Trash2, Ban, Plus, ExternalLink, Copy } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataView } from "@/components/world-class/data-view";
import { RowActions } from "@/components/world-class/row-actions";
import { useCan } from "@/lib/use-access";
import { formatDateTime, statusVariant } from "@/lib/utils";

interface ApiKey {
  id: string; label: string; owner_kind: string; owner_id: string; prefix: string;
  scopes: string[]; status: string; created_at: string; last_used_at?: string; revoked_at?: string;
}

function IssueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ label: "ops-key", owner_kind: "PLATFORM", owner_id: "tenant-default", scopes: "read,write" });
  const [secret, setSecret] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/api-keys/issue", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, scopes: form.scopes.split(",").map(s => s.trim()).filter(Boolean) }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body as { secret?: string };
    },
    onSuccess: (b) => {
      toast.success("Key issued");
      setSecret(b.secret ?? null);
      qc.invalidateQueries({ queryKey: ["admin:api-keys"] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const close = () => { setSecret(null); onOpenChange(false); };
  return (
    <Dialog open={open} onOpenChange={(o) => o ? onOpenChange(true) : close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{secret ? "Key issued — copy now" : "Issue API key"}</DialogTitle>
          <DialogDescription>{secret ? "This secret is shown ONCE. Copy and store it now." : "Owner: PLATFORM / PROVIDER / MERCHANT. Scopes are comma-separated."}</DialogDescription>
        </DialogHeader>
        {secret ? (
          <div className="space-y-2">
            <div className="break-all rounded-md border bg-[color:var(--color-surface-muted)] p-3 font-mono text-xs">{secret}</div>
            <Button variant="secondary" onClick={() => { navigator.clipboard.writeText(secret); toast.success("Copied"); }}><Copy className="h-4 w-4" /> Copy secret</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5"><Label>Label</Label><Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Owner kind</Label>
                <select className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]" value={form.owner_kind} onChange={(e) => setForm({ ...form, owner_kind: e.target.value })}>
                  <option>PLATFORM</option><option>PROVIDER</option><option>MERCHANT</option>
                </select>
              </div>
              <div className="space-y-1.5"><Label>Owner ID</Label><Input value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })} /></div>
            </div>
            <div className="space-y-1.5"><Label>Scopes (comma-separated)</Label><Input value={form.scopes} onChange={(e) => setForm({ ...form, scopes: e.target.value })} placeholder="read,write,refund" /></div>
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={close}>{secret ? "Done" : "Cancel"}</Button>
          {!secret && <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? "Issuing…" : "Issue"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminApiKeysPage() {
  const qc = useQueryClient();
  const sp = useSearchParams();
  const canCreate = useCan("api_keys", "create");
  const canUpdate = useCan("api_keys", "update");
  const canDelete = useCan("api_keys", "delete");
  const [issueOpen, setIssueOpen] = useState(false);

  useEffect(() => { if (sp.get("new") === "1" && canCreate) setIssueOpen(true); }, [sp, canCreate]);

  const q = useQuery({
    queryKey: ["admin:api-keys"],
    queryFn: async () => (await fetch("/api/admin/api-keys").then((r) => r.json())) as { keys: ApiKey[] },
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/admin/api-keys/${id}`, { method: "PATCH" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Key revoked"); qc.invalidateQueries({ queryKey: ["admin:api-keys"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });
  const del = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/admin/api-keys/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Key deleted"); qc.invalidateQueries({ queryKey: ["admin:api-keys"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const keys = q.data?.keys ?? [];

  const cols: Column<ApiKey>[] = [
    { key: "label", header: "Label" },
    { key: "owner_kind", header: "Owner", render: (r) => <Badge variant="brand">{r.owner_kind}</Badge> },
    { key: "owner_id", header: "Owner ID", render: (r) => <span className="font-mono text-xs">{r.owner_id}</span> },
    { key: "prefix", header: "Prefix", render: (r) => <span className="font-mono text-xs">{r.prefix}…</span> },
    { key: "scopes", header: "Scopes", render: (r) => (r.scopes ?? []).join(", ") || "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "last_used_at", header: "Last used", render: (r) => r.last_used_at ? <span className="text-xs">{formatDateTime(r.last_used_at)}</span> : <span className="text-xs text-[color:var(--color-text-muted)]">never</span> },
    { key: "created_at", header: "Created", render: (r) => <span className="text-xs">{formatDateTime(r.created_at)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="API keys"
        description="Platform-wide API keys. Revoke disables the key (cannot un-revoke); Delete removes the row."
        icon={KeyRound}
      />
      <DataView
        rows={keys}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search by label, owner, prefix…", fields: ["label", "owner_id", "prefix"] }}
        filters={[
          { key: "active",  label: "Active",  predicate: (r: ApiKey) => r.status === "ACTIVE" },
          { key: "revoked", label: "Revoked", predicate: (r: ApiKey) => r.status === "REVOKED" },
          { key: "platform", label: "PLATFORM", predicate: (r: ApiKey) => r.owner_kind === "PLATFORM" },
          { key: "provider", label: "PROVIDER", predicate: (r: ApiKey) => r.owner_kind === "PROVIDER" },
          { key: "merchant", label: "MERCHANT", predicate: (r: ApiKey) => r.owner_kind === "MERCHANT" },
          { key: "stale",   label: "Stale 30d+", predicate: (r: ApiKey) => {
            if (!r.last_used_at) return false;
            return Date.now() - new Date(r.last_used_at).getTime() > 30 * 86400_000;
          }},
        ]}
        fab={canCreate ? { label: "Issue key", icon: Plus, onClick: () => setIssueOpen(true) } : undefined}
        refresh={() => q.refetch()}
        savedViewKey="admin-api-keys"
        emptyTitle="No API keys issued"
        emptyDescription="Issue the first key — secret is shown ONCE so copy it immediately."
        bulkActions={canUpdate ? [{ label: "Revoke", icon: Ban, variant: "danger" as const,
          onClick: () => toast.info("Bulk revoke wires next to /api/admin/api-keys batch endpoint") }] : []}
        rowActions={(r) => (
          <RowActions
            actions={[
              { label: "Copy prefix", icon: Copy, onClick: () => { navigator.clipboard.writeText(r.prefix); toast.success("Prefix copied"); } },
              ...(canUpdate && r.status === "ACTIVE" ? [{ label: "Revoke", icon: Ban, onClick: () => revoke.mutate(r.id) }] : []),
              ...(canDelete ? [{ label: "Delete", icon: Trash2, variant: "danger" as const,
                onClick: () => { if (confirm(`Delete '${r.label}'?`)) del.mutate(r.id); } }] : []),
            ]}
          />
        )}
      />
      <IssueDialog open={issueOpen} onOpenChange={setIssueOpen} />
    </>
  );
}
