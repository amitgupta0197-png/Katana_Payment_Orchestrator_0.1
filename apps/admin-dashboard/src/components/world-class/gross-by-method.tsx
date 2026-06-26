"use client";

// Operations console: gross value by payment method × merchant.
// Matrix table (rows = merchants, columns = methods) with row/column totals.

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAmount } from "@/lib/utils";

interface Row { merchant_id: string; total: number; count: number; by_method: Record<string, number> }
interface Data { methods: string[]; channels: string[]; rows: Row[]; totals: { gross: number; by_method: Record<string, number>; by_channel: Record<string, number> } }

export function GrossByMethod() {
  const q = useQuery({
    queryKey: ["admin:gross-by-method"],
    queryFn: async () => (await fetch("/api/admin/gross-by-method").then((r) => r.json())) as Data,
    refetchInterval: 60_000,
  });
  const d = q.data;
  const methods = d?.methods ?? [];
  const rows = d?.rows ?? [];

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Gross by payment method × merchant</CardTitle>
        <CardDescription>Which method each merchant collects through, by successful gross value.</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">No transactions yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[color:var(--color-border)] text-left text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">
                  <th className="py-2 pr-4 font-medium">Merchant</th>
                  {methods.map((m) => <th key={m} className="px-3 py-2 text-right font-medium">{m}</th>)}
                  <th className="pl-3 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.merchant_id} className="border-b border-[color:var(--color-border)]/60">
                    <td className="py-2 pr-4 font-mono text-xs">{r.merchant_id}</td>
                    {methods.map((m) => (
                      <td key={m} className="px-3 py-2 text-right tabular-nums">
                        {r.by_method[m] ? formatAmount(r.by_method[m]) : <span className="text-[color:var(--color-text-subtle)]">—</span>}
                      </td>
                    ))}
                    <td className="pl-3 py-2 text-right font-medium tabular-nums">{formatAmount(r.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="text-xs font-semibold">
                  <td className="py-2 pr-4 uppercase tracking-wide text-[color:var(--color-text-muted)]">Total</td>
                  {methods.map((m) => (
                    <td key={m} className="px-3 py-2 text-right tabular-nums">{d!.totals.by_method[m] ? formatAmount(d!.totals.by_method[m]) : "—"}</td>
                  ))}
                  <td className="pl-3 py-2 text-right tabular-nums text-[color:var(--color-brand)]">{formatAmount(d!.totals.gross)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
