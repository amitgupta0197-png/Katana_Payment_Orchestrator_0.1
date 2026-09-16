"use client";

// Payout policy for one merchant: limits, allowed rails and the approval rule. Saved changes
// are audited. The Suspend switch lives with the payment config; this card only reports it.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/utils";

const RAILS = ["IMPS", "NEFT", "RTGS", "UPI"] as const;
interface Policy {
  min_txn: string | null; max_txn: string | null; daily: string | null;
  allowed_rails: string[]; approval_rule: "AUTO" | "MAKER_CHECKER";
  updated_by: string | null; updated_at: string | null;
}

export function PayoutPolicyCard({ merchantId }: { merchantId: string }) {
  const qc = useQueryClient();
  const key = ["merchant", merchantId, "payout-policy"];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/payout-policy`);
      if (r.status === 403) return { restricted: true as const };
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { policy: Policy; suspended: boolean };
    },
  });
  const data = q.data && !("restricted" in q.data) ? q.data : null;

  const [form, setForm] = useState({ min_txn: "", max_txn: "", daily: "", allowed_rails: [] as string[], approval_rule: "AUTO" });
  useEffect(() => {
    if (!data) return;
    const p = data.policy;
    setForm({ min_txn: p.min_txn ?? "", max_txn: p.max_txn ?? "", daily: p.daily ?? "", allowed_rails: p.allowed_rails, approval_rule: p.approval_rule });
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/payout-policy`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d;
    },
    onSuccess: () => { toast.success("Payout policy saved"); qc.invalidateQueries({ queryKey: key }); },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });

  const toggleRail = (r: string) => setForm((f) => ({
    ...f, allowed_rails: f.allowed_rails.includes(r) ? f.allowed_rails.filter((x) => x !== r) : [...f.allowed_rails, r],
  }));

  if (q.data && "restricted" in q.data) return null;

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          Payout policy {data?.suspended && <Badge variant="danger">Suspended — payouts refused</Badge>}
        </CardTitle>
        <CardDescription>Checked on every payout, from the dashboard or the API. Leave a limit empty for no limit; tick no rail to allow all.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1.5"><Label>Minimum per payout (₹)</Label><Input inputMode="decimal" value={form.min_txn} onChange={(e) => setForm({ ...form, min_txn: e.target.value })} placeholder="no minimum" /></div>
          <div className="space-y-1.5"><Label>Maximum per payout (₹)</Label><Input inputMode="decimal" value={form.max_txn} onChange={(e) => setForm({ ...form, max_txn: e.target.value })} placeholder="no maximum" /></div>
          <div className="space-y-1.5"><Label>Daily limit (₹)</Label><Input inputMode="decimal" value={form.daily} onChange={(e) => setForm({ ...form, daily: e.target.value })} placeholder="no daily limit" /></div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-[color:var(--color-text-muted)]">Allowed rails</span>
          {RAILS.map((r) => (
            <label key={r} className="flex items-center gap-1.5">
              <input type="checkbox" checked={form.allowed_rails.includes(r)} onChange={() => toggleRail(r)} /> {r}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[color:var(--color-text-muted)]">Approval</span>
          <select className="h-9 rounded-md border px-2 text-sm bg-[color:var(--color-surface)]"
            value={form.approval_rule} onChange={(e) => setForm({ ...form, approval_rule: e.target.value })}>
            <option value="AUTO">Automatic — only payouts of ₹50,000+ need a second person</option>
            <option value="MAKER_CHECKER">Maker-checker — every payout needs a second person</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-[color:var(--color-text-muted)]">
            {data?.policy.updated_at ? `Last changed ${formatDateTime(data.policy.updated_at)} by ${data.policy.updated_by ?? "—"}` : "Not set yet — no limits apply."}
          </span>
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !data}>{save.isPending ? "Saving…" : "Save policy"}</Button>
        </div>
      </CardContent>
    </Card>
  );
}
