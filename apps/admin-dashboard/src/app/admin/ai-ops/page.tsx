"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bot, Terminal, Activity } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/utils";

interface Agent { agent_id: string; code: string; display_name: string; purpose: string; commands: string[]; enabled: boolean; last_signal_at: string | null }
interface AnomalyGroup { group_id: string; signal_kind: string; entity_type: string; event_type: string; bucket_start: string; signal_count: number; severity: string; sample_ids: string[] }

export default function AiOpsPage() {
  const aQ = useQuery({ queryKey: ["agents"], queryFn: async () => (await fetch("/api/admin/agents").then(r => r.json())) as { agents: Agent[] } });
  const anQ = useQuery({ queryKey: ["anomalies"], queryFn: async () => (await fetch("/api/admin/anomalies").then(r => r.json())) as { groups: AnomalyGroup[]; threshold: number }, refetchInterval: 8000 });

  const [cmd, setCmd] = useState("/exceptions");
  const [out, setOut] = useState<{ text: string; command: string } | null>(null);
  const run = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/commands/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: cmd }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body;
    },
    onSuccess: (b) => { setOut(b); toast.success(`Ran ${b.command}`); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const anomalyCols: Column<AnomalyGroup>[] = [
    { key: "bucket_start", header: "Hour", render: (r) => formatDateTime(r.bucket_start) },
    { key: "severity", header: "Sev", render: (r) => <Badge variant={r.severity === "ALERT" ? "danger" : r.severity === "WARN" ? "warning" : "default"}>{r.severity}</Badge> },
    { key: "event_type", header: "Event" },
    { key: "entity_type", header: "Entity" },
    { key: "signal_count", header: "Count" },
    { key: "sample_ids", header: "Sample", render: (r) => <span className="font-mono text-xs">{(r.sample_ids ?? []).slice(0, 2).map(x => x.slice(0,8)).join(", ")}</span> },
  ];

  return (
    <>
      <PageHeader title="AI Ops" description="9 named agents + slash commands + anomaly grouping (BRD §14 P10)." icon={Bot} />
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Terminal className="h-4 w-4" /> Slash command</CardTitle>
          <CardDescription>Try: /merchant tenant-default · /provider POOLPAY · /txn TXN-XXX · /exceptions · /treasury</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input value={cmd} onChange={(e) => setCmd(e.target.value)} className="font-mono" />
            <Button onClick={() => run.mutate()} disabled={run.isPending}>Run</Button>
          </div>
          {out && (
            <pre className="font-mono text-xs whitespace-pre-wrap bg-[color:var(--color-surface)] border rounded p-3">
              {out.command}{"\n"}{out.text}
            </pre>
          )}
        </CardContent>
      </Card>
      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Agent catalog ({(aQ.data?.agents ?? []).length})</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {(aQ.data?.agents ?? []).map(a => (
              <Card key={a.agent_id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{a.display_name}</CardTitle>
                    <Badge variant={a.enabled ? "success" : "default"}>{a.enabled ? "on" : "off"}</Badge>
                  </div>
                  <CardDescription className="text-xs">{a.purpose}</CardDescription>
                </CardHeader>
                <CardContent className="text-xs">
                  <div className="flex flex-wrap gap-1">
                    {(a.commands ?? []).map((c, i) => (
                      <span key={i} className="font-mono px-2 py-0.5 rounded border bg-[color:var(--color-surface)]">{c}</span>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Activity className="h-4 w-4" /> Anomaly groups · threshold {anQ.data?.threshold ?? 5}/hr</CardTitle></CardHeader>
        <CardContent><DataTable columns={anomalyCols} rows={anQ.data?.groups ?? []} rowKey={(r) => r.group_id} emptyState="No anomalies above threshold." /></CardContent>
      </Card>
    </>
  );
}
