"use client";

// The API request log (lib/api-log). A merchant sees a summary of its own requests for the
// last 7 days: time, endpoint, status, latency, and never a body. With `staff`, the same table
// gains a per-merchant filter, a date range, the request and response bodies and a CSV export.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText, Download } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Row {
  id: string; request_id: string; merchant_id: string | null; livemode: boolean | null; api_version: string;
  method: string; endpoint: string; http_status: number; latency_ms: number; error_code: string | null; created_at: string;
  request_body?: unknown; response_body?: unknown; ip?: string | null;
}

const time = (v: string) => new Date(v).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function ApiLogView({ staff = false }: { staff?: boolean }) {
  const [merchant, setMerchant] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState<"" | "ok" | "error">("");
  const [applied, setApplied] = useState({ merchant: "", from: "", to: "" });
  const [open, setOpen] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (staff) {
    params.set("full", "1");
    if (applied.merchant) params.set("merchant", applied.merchant);
    if (applied.from) params.set("from", applied.from);
    if (applied.to) params.set("to", applied.to);
  }
  if (status) params.set("status", status);
  const qs = params.toString();

  const q = useQuery({
    queryKey: ["portal:api-log", qs],
    queryFn: async () => {
      const r = await fetch(`/api/portal/api-log?${qs}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { rows: Row[]; days: number };
    },
    refetchInterval: 30_000,
  });
  const list = q.data?.rows ?? [];

  return (
    <>
      <PageHeader title="API request log" icon={ScrollText}
        description={staff
          ? "Every request to the order APIs, with its request and response. Credentials are cut to a hint before a row is stored."
          : `Requests your server made to the order API in the last ${q.data?.days ?? 7} days.`}
        actions={staff ? (
          <Button asChild size="sm" variant="secondary"><a href={`/api/portal/api-log?${qs}&format=csv`}><Download className="h-4 w-4" /> Export CSV</a></Button>
        ) : undefined} />
      <Card>
        <CardContent className="pt-6">
          <div className="mb-3 flex flex-wrap items-end gap-2">
            {staff && (
              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setApplied({ merchant: merchant.trim(), from, to }); }}>
                <label className="text-xs text-[color:var(--color-text-muted)]">Merchant
                  <Input className="mt-1 h-8 w-40" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="banker code" /></label>
                <label className="text-xs text-[color:var(--color-text-muted)]">From
                  <Input className="mt-1 h-8" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
                <label className="text-xs text-[color:var(--color-text-muted)]">To
                  <Input className="mt-1 h-8" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
                <Button type="submit" size="sm" variant="secondary">Apply</Button>
              </form>
            )}
            <div className="ml-auto flex gap-1">
              {([["", "All"], ["ok", "Succeeded"], ["error", "Errors"]] as const).map(([v, label]) => (
                <Button key={v} size="sm" variant={status === v ? "default" : "secondary"} onClick={() => setStatus(v)}>{label}</Button>
              ))}
            </div>
          </div>

          {q.isLoading ? <p className="text-sm text-[color:var(--color-text-muted)]">Loading…</p>
            : q.error ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>
            : list.length === 0 ? <p className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">No requests in this period.</p>
            : (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[color:var(--color-surface-muted)] text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">
                    <tr>
                      <th className="px-3 py-2 font-medium">Time</th>
                      {staff && <th className="px-3 py-2 font-medium">Merchant</th>}
                      <th className="px-3 py-2 font-medium">Endpoint</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 text-right font-medium">Latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((r) => (
                      <FragmentRow key={r.id} r={r} staff={staff} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </CardContent>
      </Card>
    </>
  );
}

function FragmentRow({ r, staff, open, onToggle }: { r: Row; staff: boolean; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={`border-t border-[color:var(--color-border)] ${staff ? "cursor-pointer hover:bg-[color:var(--color-surface-muted)]" : ""}`} onClick={staff ? onToggle : undefined}>
        <td className="whitespace-nowrap px-3 py-2 tabular-nums">{time(r.created_at)}</td>
        {staff && <td className="px-3 py-2 font-mono text-xs">{r.merchant_id ?? "—"}{r.livemode === false && <Badge variant="warning" className="ml-1.5">TEST</Badge>}</td>}
        <td className="px-3 py-2"><span className="font-mono text-xs">{r.method} {r.endpoint}</span>{!staff && r.livemode === false && <Badge variant="warning" className="ml-1.5">TEST</Badge>}</td>
        <td className="px-3 py-2">
          <Badge variant={r.http_status < 400 ? "success" : r.http_status < 500 ? "warning" : "danger"}>{r.http_status}</Badge>
          {r.error_code && <span className="ml-1.5 font-mono text-xs text-[color:var(--color-text-muted)]">{r.error_code}</span>}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{r.latency_ms} ms</td>
      </tr>
      {staff && open && (
        <tr className="border-t border-[color:var(--color-border)] bg-[color:var(--color-surface-muted)]">
          <td colSpan={5} className="px-3 py-2">
            <div className="mb-1 font-mono text-xs text-[color:var(--color-text-muted)]">{r.request_id}{r.ip ? ` · ${r.ip}` : ""}</div>
            <div className="grid gap-2 lg:grid-cols-2">
              {([["Request", r.request_body], ["Response", r.response_body]] as const).map(([label, body]) => (
                <div key={label}>
                  <div className="text-xs font-medium">{label}</div>
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-[color:var(--color-surface)] p-2 text-xs">{body == null ? "—" : JSON.stringify(body, null, 2)}</pre>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
