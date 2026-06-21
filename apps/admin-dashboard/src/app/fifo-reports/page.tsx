"use client";

// FIFO reports (PayTech BRD §30). Merchant txn / operator performance / settlement
// / risk / forensic — viewable as a table and exportable to CSV.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Download } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const TYPES = [
  { key: "merchant", label: "Merchant txns" },
  { key: "operator", label: "Operator performance" },
  { key: "settlement", label: "Settlement" },
  { key: "risk", label: "Risk" },
  { key: "forensic", label: "Forensic" },
] as const;

export default function FifoReportsPage() {
  const [type, setType] = useState<(typeof TYPES)[number]["key"]>("merchant");

  const q = useQuery({
    queryKey: ["fifo-report", type],
    queryFn: async () => {
      const r = await fetch(`/api/v1/reports?type=${type}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { columns: string[]; rows: Record<string, unknown>[] };
    },
  });

  function csv() {
    if (!q.data) return;
    const { columns, rows } = q.data;
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const text = [columns.join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `fifo-${type}-report.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader title="FIFO Reports" description="Operational MIS — view and export (BRD §30)." icon={BarChart3}
        actions={<Button size="sm" variant="secondary" onClick={csv} disabled={!q.data?.rows?.length}><Download className="h-4 w-4" /> CSV</Button>} />

      <div className="mb-4 flex flex-wrap gap-1">
        {TYPES.map((t) => (
          <Button key={t.key} size="sm" variant={type === t.key ? "default" : "ghost"} onClick={() => setType(t.key)}>{t.label}</Button>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">{TYPES.find((t) => t.key === type)?.label} ({q.data?.rows?.length ?? 0})</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {q.isLoading ? <div className="text-xs text-[color:var(--color-text-muted)]">Loading…</div> :
            (q.data?.rows?.length ?? 0) === 0 ? <div className="text-xs text-[color:var(--color-text-muted)]">No data.</div> : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-[color:var(--color-text-muted)]">
                    {q.data!.columns.map((c) => <th key={c} className="px-2 py-1.5 font-medium">{c}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {q.data!.rows.map((row, i) => (
                    <tr key={i} className="border-b last:border-0">
                      {q.data!.columns.map((c) => <td key={c} className="px-2 py-1.5 font-mono">{String(row[c] ?? "—")}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </CardContent>
      </Card>
    </>
  );
}
