"use client";

// Compliance case management (PayTech BRD §23). Open cases, add notes/evidence,
// place the linked order on hold, and close.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Briefcase, Plus, Lock, MessageSquarePlus, XCircle } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/world-class/empty-state";
import { formatDateTime, statusVariant } from "@/lib/utils";

const sevVariant = (s: string) => s === "CRITICAL" || s === "HIGH" ? "danger" : s === "MEDIUM" ? "warning" : "info";

export default function CasesPage() {
  const qc = useQueryClient();
  const [nc, setNc] = useState({ subject: "", merchant_id: "", order_ref: "", severity: "MEDIUM" });
  const [sel, setSel] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const list = useQuery({
    queryKey: ["cases"],
    queryFn: async () => (await fetch("/api/v1/cases").then((r) => r.json())) as { cases: any[] },
    refetchInterval: 12000,
  });
  const detail = useQuery({
    queryKey: ["case", sel],
    queryFn: async () => (await fetch(`/api/v1/cases/${sel}`).then((r) => r.json())) as { case: any; notes: any[] },
    enabled: !!sel,
  });

  const refresh = () => { qc.invalidateQueries({ queryKey: ["cases"] }); if (sel) qc.invalidateQueries({ queryKey: ["case", sel] }); };

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/v1/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject: nc.subject, merchant_id: nc.merchant_id || undefined, order_ref: nc.order_ref || undefined, severity: nc.severity }) });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status); return d;
    },
    onSuccess: (d) => { toast.success(`Opened ${d.case?.case_ref}`); setNc({ subject: "", merchant_id: "", order_ref: "", severity: "MEDIUM" }); setSel(d.case?.id ?? null); refresh(); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const act = useMutation({
    mutationFn: async (v: { action: string; body?: string }) => {
      const r = await fetch(`/api/v1/cases/${sel}/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status); return d;
    },
    onSuccess: (_d, v) => { toast.success(`Case ${v.action}`); setNote(""); refresh(); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const cases = list.data?.cases ?? [];

  return (
    <>
      <PageHeader title="Compliance Cases" description="Open cases, attach notes/evidence, place orders on hold (BRD §23)." icon={Briefcase} />

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Open a case</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <Input className="h-9 w-64" placeholder="Subject *" value={nc.subject} onChange={(e) => setNc({ ...nc, subject: e.target.value })} />
          <Input className="h-9 w-40" placeholder="branch code" value={nc.merchant_id} onChange={(e) => setNc({ ...nc, merchant_id: e.target.value })} />
          <Input className="h-9 w-44" placeholder="order ref (optional)" value={nc.order_ref} onChange={(e) => setNc({ ...nc, order_ref: e.target.value })} />
          <select className="h-9 rounded-md border bg-transparent px-2 text-sm" value={nc.severity} onChange={(e) => setNc({ ...nc, severity: e.target.value })}>
            {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <Button size="sm" onClick={() => create.mutate()} disabled={!nc.subject || create.isPending}><Plus className="h-4 w-4" /> Open</Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Cases ({cases.length})</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {cases.length === 0 && <EmptyState icon={Briefcase} title="No cases open" description="Open a case above to investigate a flagged order or branch — attach notes/evidence and place the order on hold." />}
            {cases.map((c) => (
              <button key={c.id} onClick={() => setSel(c.id)} className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-[color:var(--color-surface-muted)] ${sel === c.id ? "border-[color:var(--color-brand)]" : ""}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{c.case_ref}</span>
                  <Badge variant={sevVariant(c.severity)}>{c.severity}</Badge>
                  <span>{c.subject}</span>
                  {c.order_ref && <span className="font-mono text-xs text-[color:var(--color-text-muted)]">{c.order_ref}</span>}
                </div>
                <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{detail.data?.case ? `${detail.data.case.case_ref} — ${detail.data.case.subject}` : "Select a case"}</CardTitle>
            {detail.data?.case && <CardDescription>{detail.data.case.merchant_id ?? "—"} · {detail.data.case.order_ref ?? "no order"} · opened by {detail.data.case.opened_by}</CardDescription>}
          </CardHeader>
          <CardContent className="space-y-3">
            {!sel && <div className="text-xs text-[color:var(--color-text-muted)]">Pick a case to see its timeline.</div>}
            {sel && detail.data?.case && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Input className="h-8 w-56" placeholder="add note…" value={note} onChange={(e) => setNote(e.target.value)} />
                  <Button size="sm" variant="secondary" onClick={() => act.mutate({ action: "note", body: note })} disabled={!note || act.isPending}><MessageSquarePlus className="h-4 w-4" /> Note</Button>
                  {detail.data.case.order_ref && <Button size="sm" variant="secondary" onClick={() => act.mutate({ action: "hold" })} disabled={act.isPending}><Lock className="h-4 w-4" /> Hold order</Button>}
                  {detail.data.case.status !== "CLOSED" && <Button size="sm" variant="danger" onClick={() => act.mutate({ action: "close" })} disabled={act.isPending}><XCircle className="h-4 w-4" /> Close</Button>}
                </div>
                <div className="space-y-1">
                  {(detail.data.notes ?? []).map((n, i) => (
                    <div key={i} className="flex items-start gap-2 rounded-md border px-3 py-1.5 text-xs">
                      <Badge variant={n.kind === "ACTION" ? "brand" : n.kind === "EVIDENCE" ? "info" : "warning"}>{n.kind}</Badge>
                      <div className="flex-1">
                        <div>{n.body}{n.evidence_ref ? <span className="font-mono"> [{n.evidence_ref}]</span> : ""}</div>
                        <div className="text-[color:var(--color-text-muted)]">{n.author} · {formatDateTime(n.created_at)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
