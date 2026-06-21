"use client";

// FIFO reports (PayTech BRD §30). Merchant txn / operator performance / settlement
// / risk / forensic — viewable as a filterable, density-adjustable table and
// exportable to CSV. Filtering/density are client-side (presentation only).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Download, Search, Rows3, Rows2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  const [filter, setFilter] = useState("");
  const [dense, setDense] = useState(false);

  const q = useQuery({
    queryKey: ["fifo-report", type],
    queryFn: async () => {
      const r = await fetch(`/api/v1/reports?type=${type}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { columns: string[]; rows: Record<string, unknown>[] };
    },
  });

  const columns = q.data?.columns ?? [];
  const allRows = q.data?.rows ?? [];
  const ql = filter.trim().toLowerCase();
  const rows = ql ? allRows.filter((r) => columns.some((c) => String(r[c] ?? "").toLowerCase().includes(ql))) : allRows;
  const pad = dense ? "py-1" : "py-2";

  function csv() {
    if (!rows.length) return;
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
        actions={<Button size="sm" variant="secondary" onClick={csv} disabled={!rows.length}><Download className="h-4 w-4" /> CSV{ql ? " (filtered)" : ""}</Button>} />

      <div className="mb-4 flex flex-wrap gap-1">
        {TYPES.map((t) => (
          <Button key={t.key} size="sm" variant={type === t.key ? "default" : "ghost"} onClick={() => { setType(t.key); setFilter(""); }}>{t.label}</Button>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="text-base">{TYPES.find((t) => t.key === type)?.label} ({rows.length}{ql ? ` of ${allRows.length}` : ""})</CardTitle>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--color-text-muted)]" />
              <Input className="h-8 w-48 pl-7 text-xs" placeholder="Filter rows…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setDense((d) => !d)} title={dense ? "Comfortable rows" : "Compact rows"}>
              {dense ? <Rows3 className="h-4 w-4" /> : <Rows2 className="h-4 w-4" />}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {q.isLoading ? <div className="text-xs text-[color:var(--color-text-muted)]">Loading…</div> :
            allRows.length === 0 ? <div className="text-xs text-[color:var(--color-text-muted)]">No data.</div> :
            rows.length === 0 ? <div className="text-xs text-[color:var(--color-text-muted)]">No rows match “{filter}”.</div> : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-[color:var(--color-text-muted)]">
                    {columns.map((c) => <th key={c} className={`px-2 ${pad} font-medium`}>{c}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-[color:var(--color-surface-muted)]">
                      {columns.map((c) => <td key={c} className={`px-2 ${pad} font-mono`}>{String(row[c] ?? "—")}</td>)}
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
