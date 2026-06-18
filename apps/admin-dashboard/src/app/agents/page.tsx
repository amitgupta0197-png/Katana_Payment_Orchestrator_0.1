"use client";

import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";

interface Agent {
  id: string; code: string; parent_id: string; tier: string; legal_name: string;
  contact_email: string; contact_phone: string; status: string;
  advance_balance: number; currency: string; low_balance_threshold: number; created_at: string;
}

export default function AgentsPage() {
  const q = useQuery({
    queryKey: ["agents"],
    queryFn: async () => (await fetch("/api/agents").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { agents: Agent[] },
  });
  const cols: Column<Agent>[] = [
    { key: "code", header: "Code" },
    { key: "tier", header: "Tier" },
    { key: "legal_name", header: "Legal name" },
    { key: "contact_email", header: "Contact" },
    { key: "advance_balance", header: "Advance", render: (r) => formatAmount(r.advance_balance, r.currency) },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "created_at", header: "Joined", render: (r) => formatDateTime(r.created_at) },
  ];
  return (
    <>
      <PageHeader title="Agents & franchise" description="Sub-admin franchise tree (PRODUCT_VISION §3.11)." icon={Users} />
      <Card><CardHeader><CardTitle>{(q.data?.agents ?? []).length} agents</CardTitle></CardHeader>
        <CardContent><DataTable columns={cols} rows={q.data?.agents ?? []} loading={q.isLoading} rowKey={(r) => r.id} emptyState="No agents in tree." /></CardContent>
      </Card>
    </>
  );
}
