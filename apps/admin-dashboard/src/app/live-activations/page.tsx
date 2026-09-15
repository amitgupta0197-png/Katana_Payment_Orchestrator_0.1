"use client";

// Super Admin queue of "Activate live mode" requests. Decisions are made on the banker's page,
// where the full checklist is shown next to the approve / reject buttons.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";

type Status = "NOT_REQUESTED" | "REQUESTED" | "ACTIVATED" | "REJECTED";

interface Row {
  merchant_code: string; merchant_id: string | null; name: string | null; status: Status; grandfathered: boolean;
  requested_at: string | null; requested_by: string | null; decided_at: string | null; decided_by: string | null; reason: string | null;
}

const STATUS: Record<Status, { label: string; variant: "success" | "warning" | "danger" | "default" }> = {
  NOT_REQUESTED: { label: "Not requested", variant: "default" },
  REQUESTED: { label: "Waiting for approval", variant: "warning" },
  ACTIVATED: { label: "Active", variant: "success" },
  REJECTED: { label: "Rejected", variant: "danger" },
};

const FILTERS: { value: string; label: string }[] = [
  { value: "REQUESTED", label: "Waiting for approval" },
  { value: "ACTIVATED", label: "Active" },
  { value: "REJECTED", label: "Rejected" },
  { value: "ALL", label: "All" },
];

export default function LiveActivationsPage() {
  const [filter, setFilter] = useState("REQUESTED");
  const q = useQuery({
    queryKey: ["live-activations", filter],
    queryFn: async () =>
      (await fetch(`/api/live-activations?status=${filter}`).then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
        return d;
      })) as { activations: Row[]; pending: number },
  });

  const cols: Column<Row>[] = [
    {
      key: "merchant_code", header: "Banker", render: (r) => r.merchant_id
        ? <Link href={`/merchants/${r.merchant_id}`} className="font-medium text-[color:var(--color-brand)] hover:underline">{r.name ?? r.merchant_code}</Link>
        : <span className="font-medium">{r.name ?? r.merchant_code}</span>,
    },
    { key: "name", header: "Code", render: (r) => <span className="font-mono text-xs">{r.merchant_code}</span> },
    {
      key: "status", header: "Status", render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
          {r.grandfathered && <span className="text-xs text-[color:var(--color-text-muted)]">already live</span>}
        </span>
      ),
    },
    { key: "requested_at", header: "Requested", render: (r) => r.requested_at ? `${formatDateTime(r.requested_at)}${r.requested_by ? ` · ${r.requested_by}` : ""}` : "—" },
    { key: "decided_at", header: "Decided", render: (r) => r.decided_at ? `${formatDateTime(r.decided_at)}${r.decided_by ? ` · ${r.decided_by}` : ""}` : "—" },
    { key: "reason", header: "Note", render: (r) => r.reason ? <span title={r.reason} className="block max-w-xs truncate">{r.reason}</span> : "—" },
  ];

  return (
    <>
      <PageHeader
        title="Live activations"
        description="Bankers asking to take real payments. Open a banker to review its checklist and approve or reject."
        icon={Rocket}
      />
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>
            {(q.data?.activations ?? []).length} shown{q.data?.pending ? ` · ${q.data.pending} waiting` : ""}
          </CardTitle>
          <select
            aria-label="Filter by status"
            className="rounded-md border border-[color:var(--color-border-strong)] bg-[color:var(--color-surface)] px-2 py-1 text-xs"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={q.data?.activations ?? []}
            loading={q.isLoading}
            rowKey={(r) => r.merchant_code}
            emptyState={filter === "REQUESTED" ? "No bankers are waiting for approval." : "Nothing here."}
          />
        </CardContent>
      </Card>
    </>
  );
}
