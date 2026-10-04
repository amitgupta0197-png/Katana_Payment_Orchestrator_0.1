"use client";

// The banker switch (lib/banker-switch) on the MID switch page: which of the merchant's bankers
// takes each order signed with any of their Keys. Each banker is shown with its live Key (staff also
// see the first characters of its Salt; a merchant nothing of it, lib/key-access),
// whether it can take live orders, today's orders, its place in rotation, and the manual switch.
// Merchant portal: the signed-in merchant's switch. Staff: the switch of the chosen banker's merchant.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shuffle, Zap } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatAmount, formatDateTime } from "@/lib/utils";
import { usePortal } from "@/components/portal/portal-frame";

interface Row {
  banker: string; name: string; in_rotation: boolean; priority: number; weight: number;
  live_key: { key: string; salt_hint: string | null } | null; test_key: { key: string; salt_hint: string | null } | null;
  live_ready: boolean; not_ready: string[]; today: { orders: number; amount: number; paid: number };
  pinned: boolean; in_use: boolean;
}
interface Detail {
  provider_id: string; staff: boolean; can_change: boolean;
  settings: { enabled: boolean; mode: "PRIORITY" | "WEIGHTED"; pinned_banker: string | null; pinned_until: string | null; pin_reason: string | null; last_banker: string | null };
  next_order: string[];
  bankers: Row[];
  events: { at: string; action: string; who: string; text: string }[];
}

const MUTED = "text-[color:var(--color-text-muted)]";

export function BankerSwitchCard({ banker }: { banker?: string }) {
  const portal = usePortal();
  const qc = useQueryClient();
  const qs = banker ? `?banker=${encodeURIComponent(banker)}` : "";
  const key = ["banker-switch", banker ?? "own"];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/banker-switch${qs}`);
      if (r.status === 404) return null;
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d as Detail;
    },
  });
  const m = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const r = await fetch("/api/banker-switch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: q.data?.provider_id, ...body }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d as Detail;
    },
    onSuccess: (d) => { qc.setQueryData(key, d); toast.success("Saved"); },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });
  const [showLog, setShowLog] = useState(false);

  const d = q.data;
  if (q.isLoading) return null;
  if (q.isError) return <Card className="mb-4"><CardContent className="py-4 text-sm text-[color:var(--color-danger)]">Banker switch: {(q.error as Error).message}</CardContent></Card>;
  if (!d || d.bankers.length < 2) return null;   // one banker: nothing to switch between

  const s = d.settings;
  const can = d.can_change && !m.isPending;
  const keysHref = portal ? `${portal.base}/keys` : null;
  const nextName = d.next_order[0] ? d.bankers.find((b) => b.banker === d.next_order[0])?.name : null;

  return (
    <Card className="mb-4">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><Shuffle className="h-4 w-4" /> Banker switch</CardTitle>
            <CardDescription className="mt-1 max-w-3xl">
              Sign orders with any of your bankers&rsquo; Keys. With the switch on, Katana gives each order to the banker picked here and passes over one that cannot take it (not live, over a limit, no account free).
              The order, its money and its settlement belong to the banker that took it; the callback still comes signed with the Salt the order was signed with.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={s.enabled ? "success" : "default"}>{s.enabled ? "On" : "Off"}</Badge>
            {d.can_change && (
              <Button size="sm" variant={s.enabled ? "secondary" : "default"} disabled={!can} onClick={() => m.mutate({ action: "settings", enabled: !s.enabled })}>
                {s.enabled ? "Turn off" : "Turn on"}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className={MUTED}>Pick by</span>
          <div className="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label="Pick by">
            {(["PRIORITY", "WEIGHTED"] as const).map((mode) => (
              <button key={mode} type="button" role="radio" aria-checked={s.mode === mode} disabled={!can}
                onClick={() => s.mode !== mode && m.mutate({ action: "settings", mode })}
                className={`rounded px-3 py-1 ${s.mode === mode ? "bg-[color:var(--color-surface-muted)] font-medium" : MUTED}`}>
                {mode === "PRIORITY" ? "Priority" : "Weighted split"}
              </button>
            ))}
          </div>
          {s.pinned_banker ? (
            <span className="flex items-center gap-2">
              <Badge variant="warning"><Zap className="mr-1 h-3 w-3" />All orders to {d.bankers.find((b) => b.banker === s.pinned_banker)?.name ?? s.pinned_banker}{s.pinned_until ? ` until ${formatDateTime(s.pinned_until)}` : ""}</Badge>
              {d.can_change && <Button size="sm" variant="ghost" disabled={!can} onClick={() => m.mutate({ action: "unpin" })}>Back to automatic</Button>}
            </span>
          ) : s.enabled && nextName ? <span className={MUTED}>Next order goes to <b className="text-[color:var(--color-text)]">{nextName}</b>{s.mode === "WEIGHTED" ? " (most likely)" : ""}</span> : null}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className={`border-b text-left text-xs ${MUTED}`}>
              <th className="px-2 py-1.5">Banker</th><th className="px-2 py-1.5">Live Key</th><th className="px-2 py-1.5">Ready</th>
              <th className="px-2 py-1.5">Today</th><th className="px-2 py-1.5">In rotation</th>
              <th className="px-2 py-1.5">{s.mode === "PRIORITY" ? "Priority" : "Weight"}</th><th className="px-2 py-1.5"></th>
            </tr></thead>
            <tbody>
              {d.bankers.map((b) => (
                <tr key={b.banker} className="border-b last:border-0 align-top">
                  <td className="px-2 py-2">
                    <div className="font-medium">{b.name}</div>
                    <div className={`font-mono text-xs ${MUTED}`}>{b.banker}</div>
                    <div className="mt-1 flex gap-1">
                      {b.in_use && <Badge variant="info">In use now</Badge>}
                      {b.pinned && <Badge variant="warning">Switched to</Badge>}
                    </div>
                  </td>
                  <td className="px-2 py-2 font-mono text-xs">
                    {b.live_key ? <><div>{b.live_key.key}</div>{b.live_key.salt_hint && <div className={MUTED}>Salt {b.live_key.salt_hint} · sealed</div>}</>
                      : <span className={MUTED}>No live Key{keysHref ? " · the banker makes it on its portal" : ""}</span>}
                  </td>
                  <td className="px-2 py-2 text-xs">
                    {b.live_ready ? <Badge variant="success">Can take live orders</Badge> : <span className="text-[color:var(--color-warning)]">{b.not_ready.join("; ")}</span>}
                  </td>
                  <td className="px-2 py-2 text-xs tabular-nums">{b.today.orders} orders<div className={MUTED}>{formatAmount(b.today.amount)} · paid {formatAmount(b.today.paid)}</div></td>
                  <td className="px-2 py-2">
                    <input type="checkbox" className="h-4 w-4 accent-[color:var(--color-brand)]" checked={b.in_rotation} disabled={!can}
                      onChange={(e) => m.mutate({ action: "member", banker: b.banker, in_rotation: e.target.checked })} aria-label={`${b.name} in rotation`} />
                  </td>
                  <td className="px-2 py-2">
                    <NumberCell key={`${b.banker}:${s.mode}:${s.mode === "PRIORITY" ? b.priority : b.weight}`} disabled={!can}
                      value={s.mode === "PRIORITY" ? b.priority : b.weight} min={s.mode === "PRIORITY" ? 1 : 0} max={s.mode === "PRIORITY" ? 99 : 100}
                      onSave={(v) => m.mutate({ action: "member", banker: b.banker, [s.mode === "PRIORITY" ? "priority" : "weight"]: v })} />
                  </td>
                  <td className="px-2 py-2 text-right">
                    {d.can_change && !b.pinned && (
                      <Button size="sm" variant="secondary" disabled={!can} onClick={() => m.mutate({ action: "pin", banker: b.banker })}>Send all here</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={`text-xs ${MUTED}`}>
          {s.mode === "PRIORITY" ? "Lowest number first; equal numbers share by fewer orders today." : "Orders are split at random in proportion to the weights; 0 takes none."}{" "}
          A banker out of rotation still takes orders when you send all orders to it. Each banker&rsquo;s own MIDs then decide which of its accounts or UPI IDs is used.
        </p>

        <div>
          <button type="button" className="text-xs text-[color:var(--color-brand)] hover:underline" onClick={() => setShowLog((v) => !v)}>
            {showLog ? "Hide" : "Show"} switch log ({d.events.length})
          </button>
          {showLog && (
            <ul className="mt-2 space-y-1 text-xs">
              {d.events.length === 0 && <li className={MUTED}>Nothing yet.</li>}
              {d.events.map((e, i) => (
                <li key={i} className="flex gap-2"><span className={`shrink-0 ${MUTED}`}>{formatDateTime(e.at)}</span><span>{e.text}</span><span className={`ml-auto shrink-0 ${MUTED}`}>{e.who}</span></li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function NumberCell({ value, min, max, disabled, onSave }: { value: number; min: number; max: number; disabled: boolean; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  const save = () => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) { setV(String(value)); toast.error(`Use a whole number from ${min} to ${max}`); return; }
    if (n !== value) onSave(n);
  };
  return <Input className="h-8 w-20" inputMode="numeric" value={v} disabled={disabled} onChange={(e) => setV(e.target.value)}
    onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />;
}
