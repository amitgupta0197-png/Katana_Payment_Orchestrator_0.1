"use client";

// Chargebacks for the provider's assigned bankers. Read-only: a provider can see what was
// charged back, what was debited under its terms and why, and export it; recording and deciding
// chargebacks stays with Katana staff, where the evidence and the bank relationship live.
//
// The banker-side chargebacks on Katana Pay pay-ins come from /api/chargebacks (components/
// chargebacks). Card disputes on checkout orders (/api/disputes, scoped to the provider's own
// bankers) are listed below them when there are any.

import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, Download, Clock } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { formatAmount, formatDateTime, statusVariant } from "@/lib/utils";
import { ChargebacksList } from "@/components/chargebacks/chargebacks-list";

interface Dispute {
  dispute_id: string; txn_id: string; order_id: string | null; merchant_id: string;
  reason_code: string; amount_minor: string; currency: string; status: string;
  deadline_at: string | null; opened_at: string; resolved_at: string | null;
  resolution_notes: string;
}

const rupees = (minor: string) => Number(minor || 0) / 100;

/** Open disputes are the ones still costing money — everything not yet resolved. */
const isOpen = (d: Dispute) => !/^(WON|LOST|RESOLVED|CLOSED|ACCEPTED)$/i.test(d.status);

export default function ChargebacksPage() {
  return (
    <>
      <PageHeader title="Chargebacks" description="Chargebacks your bankers' banks reported, matched to the original payment in its own channel." icon={ShieldAlert} />
      <ChargebacksList />
      <CardDisputes />
    </>
  );
}

function CardDisputes() {
  const q = useQuery({
    queryKey: ["pp:disputes"],
    queryFn: async () => (await fetch("/api/disputes").then(async (r) => {
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d;
    })) as { disputes: Dispute[] },
    refetchInterval: 60_000,
  });

  const list = q.data?.disputes ?? [];
  const open = list.filter(isOpen);
  const openValue = open.reduce((s, d) => s + rupees(d.amount_minor), 0);
  // A deadline that has passed with no resolution is the expensive case: miss it and
  // the chargeback is lost by default, so it is surfaced on its own tile.
  const overdue = open.filter((d) => d.deadline_at && +new Date(d.deadline_at) < Date.now());

  const cols: Column<Dispute>[] = [
    { key: "opened_at", header: "Opened", render: (r) => <span className="text-xs">{formatDateTime(r.opened_at)}</span> },
    { key: "txn_id", header: "Transaction", render: (r) => <span className="font-mono text-xs">{r.txn_id}</span> },
    { key: "merchant_id", header: "Banker", render: (r) => <span className="font-mono text-xs">{r.merchant_id}</span> },
    { key: "reason_code", header: "Reason", render: (r) => r.reason_code || "—" },
    { key: "amount_minor", header: "Amount", render: (r) => <span className="tabular-nums">{formatAmount(rupees(r.amount_minor))}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    {
      key: "deadline_at", header: "Respond by", render: (r) => {
        if (!r.deadline_at) return <span className="text-[color:var(--color-text-muted)]">—</span>;
        const late = isOpen(r) && +new Date(r.deadline_at) < Date.now();
        return (
          <span className={`text-xs ${late ? "font-medium text-[color:var(--color-danger)]" : ""}`}>
            {late && <Clock className="mr-1 inline h-3 w-3" />}{formatDateTime(r.deadline_at)}
          </span>
        );
      },
    },
  ];

  // Only shown when there are card disputes: most merchants have none.
  if (!list.length) return null;
  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">Card disputes</h2>
        <Button variant="secondary" size="sm" asChild>
          <a href="/api/disputes/export"><Download className="h-4 w-4" /> Download CSV</a>
        </Button>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Open" value={open.length} icon={ShieldAlert} variant={open.length > 0 ? "warning" : "default"} loading={q.isLoading} />
        <KpiTile label="Value at risk" value={formatAmount(openValue)} sublabel="open disputes" loading={q.isLoading} />
        <KpiTile label="Past deadline" value={overdue.length} variant={overdue.length > 0 ? "danger" : "default"} icon={Clock} loading={q.isLoading} />
        <KpiTile label="Total" value={list.length} loading={q.isLoading} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All card disputes</CardTitle>
          <CardDescription>Newest first. Contact your Katana account manager to contest one.</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable columns={cols} rows={list} rowKey={(r) => r.dispute_id} loading={q.isLoading}
            emptyState={q.error ? String(q.error.message) : "No card disputes."} />
        </CardContent>
      </Card>
    </div>
  );
}
