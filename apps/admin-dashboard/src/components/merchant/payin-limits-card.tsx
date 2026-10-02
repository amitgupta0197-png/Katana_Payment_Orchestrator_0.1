"use client";

// Pay-in limits for one banker: ticket size, the day's total and the order rate. Checked when
// an order is created, on every order API. Saved changes are audited.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/utils";

interface Limits { min: number | null; max: number | null; daily: number | null; max_tps: number | null; set_by: string | null; set_at: string | null }
interface Data {
  limits: Limits;
  platform: { min: number | null; upi_max: number | null; daily: number | null; max_tps: number | null };
  usage: { day_amount: number };
}

const inr = (n: number | null) => (n == null ? null : `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const text = (n: number | null) => (n == null ? "" : String(n));

export function PayinLimitsCard({ merchantId }: { merchantId: string }) {
  const qc = useQueryClient();
  const key = ["merchant", merchantId, "payin-limits"];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/payin-limits`);
      if (r.status === 403) return { restricted: true as const };
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as Data;
    },
  });
  const data = q.data && !("restricted" in q.data) ? q.data : null;

  const [form, setForm] = useState({ min: "", max: "", daily: "", max_tps: "" });
  useEffect(() => {
    if (!data) return;
    const l = data.limits;
    setForm({ min: text(l.min), max: text(l.max), daily: text(l.daily), max_tps: text(l.max_tps) });
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/payin-limits`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d;
    },
    onSuccess: () => { toast.success("Pay-in limits saved"); qc.invalidateQueries({ queryKey: key }); },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });

  if (q.data && "restricted" in q.data) return null;
  const p = data?.platform;

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-base">Pay-in limits</CardTitle>
        <CardDescription>
          Checked on every live order before it is created. An empty limit takes the platform default.
          A maximum set here also replaces the UPI limit for this banker.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1.5"><Label>Minimum per order (₹)</Label><Input inputMode="decimal" value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} placeholder={p?.min != null ? `default ${inr(p.min)}` : "no minimum"} /></div>
          <div className="space-y-1.5"><Label>Maximum per order (₹)</Label><Input inputMode="decimal" value={form.max} onChange={(e) => setForm({ ...form, max: e.target.value })} placeholder={p?.upi_max != null ? `UPI limit ${inr(p.upi_max)}` : "no maximum"} /></div>
          <div className="space-y-1.5"><Label>Daily limit (₹)</Label><Input inputMode="decimal" value={form.daily} onChange={(e) => setForm({ ...form, daily: e.target.value })} placeholder={p?.daily != null ? `default ${inr(p.daily)}` : "no daily limit"} /></div>
          <div className="space-y-1.5"><Label>Orders a second</Label><Input inputMode="numeric" value={form.max_tps} onChange={(e) => setForm({ ...form, max_tps: e.target.value })} placeholder={p?.max_tps != null ? `default ${p.max_tps}` : "no rate limit"} /></div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-[color:var(--color-text-muted)]">
            {data ? `Taken today: ${inr(data.usage.day_amount)}. ` : ""}
            {data?.limits.set_at ? `Last changed ${formatDateTime(data.limits.set_at)} by ${data.limits.set_by ?? "—"}` : "No limits of its own yet."}
          </span>
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !data}>{save.isPending ? "Saving…" : "Save limits"}</Button>
        </div>
      </CardContent>
    </Card>
  );
}
