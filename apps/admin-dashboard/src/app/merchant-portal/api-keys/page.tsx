"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Copy } from "lucide-react";
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

interface ApiKey {
  id: string; label: string; prefix: string; scopes: string[]; status: string;
  created_at: string; last_used_at?: string; revoked_at?: string;
}

const SCOPES = ["payin", "payout", "refund", "status"] as const;

function IssueDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [form, setForm] = useState({ label: "Production key", scopes: ["payin", "status"] as string[] });

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/admin/api-keys/issue", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json() as Promise<{ secret: string }>;
    },
    onSuccess: (data) => {
      setSecret(data.secret);
      qc.invalidateQueries({ queryKey: ["mp:api-keys"] });
      toast.success("Key issued — copy the secret now, it won't be shown again");
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const close = () => { setOpen(false); setSecret(null); };
  const toggle = (s: string) => setForm((f) => ({
    ...f, scopes: f.scopes.includes(s) ? f.scopes.filter((x) => x !== s) : [...f.scopes, s],
  }));
  const copySecret = async () => {
    if (secret) { await navigator.clipboard.writeText(secret); toast.success("Copied"); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => o ? setOpen(true) : close()}>
      <DialogTrigger asChild><Button><Plus /> Issue key</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{secret ? "Save your secret" : "Issue API key"}</DialogTitle>
          <DialogDescription>
            {secret ? "Copy this now — it's shown once." : "Pick scopes. The platform never stores the raw secret."}
          </DialogDescription>
        </DialogHeader>
        {secret ? (
          <div className="space-y-3">
            <div className="rounded-md border bg-[color:var(--color-surface-muted)] p-3 font-mono text-xs break-all">{secret}</div>
            <Button onClick={copySecret} variant="secondary"><Copy className="h-4 w-4" /> Copy</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Label</Label>
              <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Scopes</Label>
              <div className="flex flex-wrap gap-2">
                {SCOPES.map((s) => (
                  <button
                    key={s} type="button" onClick={() => toggle(s)}
                    className={`rounded-md border px-3 py-1 text-xs ${form.scopes.includes(s) ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]" : "text-[color:var(--color-text-muted)]"}`}
                  >{s}</button>
                ))}
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          {secret ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={close}>Cancel</Button>
              <Button onClick={() => m.mutate()} disabled={m.isPending || form.scopes.length === 0}>
                {m.isPending ? "Issuing…" : "Issue"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ApiKeysPage() {
  const q = useQuery({
    queryKey: ["mp:api-keys"],
    queryFn: async () => (await fetch("/api/admin/api-keys").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { keys: ApiKey[] },
  });

  const cols: Column<ApiKey>[] = [
    { key: "label", header: "Label" },
    { key: "prefix", header: "Prefix", render: (r) => <span className="font-mono text-xs">{r.prefix}…</span> },
    { key: "scopes", header: "Scopes", render: (r) => (r.scopes ?? []).join(", ") || "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
    { key: "last_used_at", header: "Last used", render: (r) => r.last_used_at ? formatDateTime(r.last_used_at) : "—" },
  ];

  return (
    <>
      <PageHeader title="API keys" description="Manage your integration credentials." icon={KeyRound} actions={<IssueDialog />} />
      <Card>
        <CardHeader>
          <CardTitle>{(q.data?.keys ?? []).length} keys</CardTitle>
          <CardDescription>Keys are scoped to your merchant only.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={q.data?.keys ?? []}
            loading={q.isLoading}
            rowKey={(r) => r.id}
            emptyState="No keys issued. Click Issue key to create one."
          />
        </CardContent>
      </Card>
    </>
  );
}
