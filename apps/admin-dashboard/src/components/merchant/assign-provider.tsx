"use client";

// Assign an onboarded merchant to a provider, and show current provider
// attribution (which provider sourced it + who onboarded it). Used on the
// Merchants list (row action) and the merchant detail page.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { formatDateTime } from "@/lib/utils";

interface Provider { id: string; code: string; legal_name: string }
interface Mapping { provider_id: string; code: string; legal_name: string; kind?: string; status: string; mapped_by: string; mapped_at: string }
interface Attribution { merchant_code: string; mappings: Mapping[]; onboarded_by: string; onboarded_at: string | null }

export function AssignProviderDialog({
  merchantId, merchantCode, open, onOpenChange,
}: {
  merchantId: string;
  merchantCode?: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [providerId, setProviderId] = useState("");

  const providersQ = useQuery({
    queryKey: ["providers"],
    enabled: open,
    queryFn: async () => {
      const r = await fetch("/api/providers");
      if (!r.ok) return { providers: [] as Provider[] };
      return (await r.json()) as { providers: Provider[] };
    },
  });
  const providers = providersQ.data?.providers ?? [];

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/provider`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider_id: providerId }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success("Branch assigned to provider");
      onOpenChange(false);
      setProviderId("");
      qc.invalidateQueries({ queryKey: ["merchants"] });
      qc.invalidateQueries({ queryKey: ["merchant-provider", merchantId] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign to provider</DialogTitle>
          <DialogDescription>
            Map {merchantCode ? <span className="font-mono">{merchantCode}</span> : "this merchant"} under a
            provider so traffic, commissions, and reporting trace back to who sourced it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Provider</Label>
          <select
            className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
          >
            <option value="">— Select a provider —</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.code} — {p.legal_name}</option>
            ))}
          </select>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !providerId}>
            {m.isPending ? "Assigning…" : "Assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProviderAttributionCard({ merchantId, merchantCode }: { merchantId: string; merchantCode?: string }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["merchant-provider", merchantId],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/provider`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as Attribution;
    },
  });
  const data = q.data;
  const mappings = data?.mappings ?? [];

  const unassign = useMutation({
    mutationFn: async (providerId: string) => {
      const r = await fetch(`/api/merchants/${merchantId}/provider?provider_id=${providerId}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success("Provider unassigned");
      qc.invalidateQueries({ queryKey: ["merchant-provider", merchantId] });
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  return (
    <Card className="mb-4">
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">Provider attribution</CardTitle>
          <CardDescription>Which provider sourced this branch, and who onboarded it.</CardDescription>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          <Link2 className="h-4 w-4" /> {mappings.length ? "Change / add" : "Assign provider"}
        </Button>
      </CardHeader>
      <CardContent className="text-sm space-y-3">
        {q.isLoading ? (
          <div className="text-[color:var(--color-text-muted)]">Loading…</div>
        ) : mappings.length === 0 ? (
          <div className="rounded-md border border-dashed px-3 py-4 text-center text-[color:var(--color-text-muted)]">
            Not mapped to any provider yet. Assign one to trace the source.
          </div>
        ) : (
          <ul className="space-y-2">
            {mappings.map((mp) => (
              <li key={mp.provider_id} className="flex items-center justify-between gap-2 rounded-md border p-2">
                <div className="min-w-0">
                  <div className="font-medium truncate">{mp.code} — {mp.legal_name}</div>
                  <div className="text-xs text-[color:var(--color-text-muted)]">
                    Mapped {formatDateTime(mp.mapped_at)}{mp.mapped_by ? ` · by ${mp.mapped_by}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={mp.status === "ACTIVE" ? "success" : "default"}>{mp.status}</Badge>
                  <Button size="sm" variant="ghost" disabled={unassign.isPending}
                    onClick={() => unassign.mutate(mp.provider_id)}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t pt-2 text-xs text-[color:var(--color-text-muted)]">
          Onboarded by: <span className="text-[color:var(--color-text)]">{data?.onboarded_by || "—"}</span>
          {data?.onboarded_at ? ` · ${formatDateTime(data.onboarded_at)}` : ""}
        </div>
      </CardContent>
      <AssignProviderDialog merchantId={merchantId} merchantCode={merchantCode} open={open} onOpenChange={setOpen} />
    </Card>
  );
}
