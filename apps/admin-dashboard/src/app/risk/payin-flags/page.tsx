"use client";

// Pay-in compliance flags (lib/payin-compliance): transaction patterns found on live pay-ins,
// for a person to review. Staff only — a flag is about a merchant and is never shown to one.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/utils";

interface Flag {
  id: string; merchant_id: string; rule: string; label: string; flag_date: string;
  severity: "INFO" | "WARN" | "CRITICAL"; detail: Record<string, number>; status: string;
  last_seen_at: string; reviewed_by: string | null; reviewed_at: string | null; review_note: string | null;
}
type Decision = "CLEARED" | "ESCALATED" | "REPORTED";

const SEVERITY = { INFO: "default", WARN: "warning", CRITICAL: "danger" } as const;
const STATUS = { OPEN: "warning", CLEARED: "success", ESCALATED: "danger", REPORTED: "info" } as const;
const FILTERS = ["OPEN", "ESCALATED", "REPORTED", "CLEARED", "ALL"] as const;

const detailText = (d: Record<string, number>) =>
  Object.entries(d).map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "number" ? v.toLocaleString("en-IN") : v}`).join(" · ");

function ReviewRow({ flag }: { flag: Flag }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const review = useMutation({
    mutationFn: async (status: Decision) => {
      const r = await fetch(`/api/risk/payin-flags/${flag.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, note }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return status;
    },
    onSuccess: (status) => { toast.success(`Flag ${status.toLowerCase()}`); setNote(""); qc.invalidateQueries({ queryKey: ["payin-flags"] }); },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });
  const busy = review.isPending;
  return (
    <li className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={SEVERITY[flag.severity]}>{flag.severity}</Badge>
        <Badge variant={STATUS[flag.status as keyof typeof STATUS] ?? "default"}>{flag.status}</Badge>
        <span className="font-mono text-xs">{flag.merchant_id}</span>
        <span className="font-medium">{flag.label}</span>
        <span className="ml-auto text-xs text-[color:var(--color-text-muted)]">{flag.flag_date}</span>
      </div>
      <div className="mt-1 text-xs text-[color:var(--color-text-muted)]">{detailText(flag.detail)}</div>
      {flag.reviewed_by ? (
        <div className="mt-2 text-xs">
          {flag.status.toLowerCase()} by {flag.reviewed_by}{flag.reviewed_at ? ` on ${formatDateTime(flag.reviewed_at)}` : ""}: {flag.review_note}
        </div>
      ) : flag.severity !== "INFO" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input className="h-8 min-w-[220px] flex-1" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you found (required)" />
          <Button size="sm" variant="secondary" disabled={busy || note.trim().length < 3} onClick={() => review.mutate("CLEARED")}>Clear</Button>
          <Button size="sm" variant="secondary" disabled={busy || note.trim().length < 3} onClick={() => review.mutate("ESCALATED")}>Escalate</Button>
          <Button size="sm" disabled={busy || note.trim().length < 3} onClick={() => review.mutate("REPORTED")}>Mark reported</Button>
        </div>
      )}
    </li>
  );
}

export default function PayinFlagsPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("OPEN");
  const q = useQuery({
    queryKey: ["payin-flags", filter],
    queryFn: async () => {
      const r = await fetch(`/api/risk/payin-flags${filter === "ALL" ? "" : `?status=${filter}`}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d.flags as Flag[];
    },
    refetchInterval: 60_000,
  });
  const flags = q.data ?? [];
  return (
    <div>
      <PageHeader
        title="Pay-in flags" icon={ShieldAlert}
        description="Transaction patterns found on live, paid pay-ins. A flag is a prompt to look, not a finding: clear it, escalate it, or mark it reported once an STR or CTR has been filed."
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex flex-wrap items-center gap-2">
            Flags
            {FILTERS.map((f) => (
              <Button key={f} size="sm" variant={f === filter ? "default" : "secondary"} onClick={() => setFilter(f)}>{f[0] + f.slice(1).toLowerCase()}</Button>
            ))}
          </CardTitle>
          <CardDescription>Checked every five minutes. One flag per banker, rule and day; high-value orders are listed for the record and need no review.</CardDescription>
        </CardHeader>
        <CardContent>
          {q.isLoading ? <p className="text-sm text-[color:var(--color-text-muted)]">Loading…</p>
            : q.error ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>
            : flags.length === 0 ? <p className="text-sm text-[color:var(--color-text-muted)]">No {filter === "ALL" ? "" : filter.toLowerCase() + " "}flags.</p>
            : <ul className="space-y-2">{flags.map((f) => <ReviewRow key={f.id} flag={f} />)}</ul>}
        </CardContent>
      </Card>
    </div>
  );
}
