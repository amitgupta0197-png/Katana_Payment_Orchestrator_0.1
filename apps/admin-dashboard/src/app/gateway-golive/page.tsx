"use client";

// The gateway go-live checklist (lib/gateway-golive). A banker's gateway account takes only a
// few small verification payments until every item is recorded, then a named member of staff
// sets it LIVE. STAFF ONLY — this page names gateways.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Rocket, Check, Circle } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/utils";

interface Item { key: string; label: string; done: boolean; at: string | null; by: string | null; detail: string | null }
interface Account {
  merchant_id: string; gateway: string; status: "VERIFYING" | "LIVE"; created_at: string; created_by: string | null;
  live_at: string | null; live_by: string | null; note: string | null; callback_url: string | null; sends_webhooks: boolean;
  credentials_match: boolean; checklist: Item[]; can_go_live: boolean;
}
type Action = "ping" | "webhook" | "status" | "live";
const ACTION: Record<string, { action: Action; label: string }> = {
  PING: { action: "ping", label: "Ping callback URL" },
  WEBHOOK: { action: "webhook", label: "Look for a confirmed payment" },
  STATUS: { action: "status", label: "Run status check" },
};

function AccountCard({ a }: { a: Account }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const run = useMutation({
    mutationFn: async (action: Action) => {
      const r = await fetch("/api/ops/gateway-golive", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchant_id: a.merchant_id, gateway: a.gateway, action, note: note.trim() || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { answer?: string };
    },
    onSuccess: (d, action) => {
      if (d.answer && d.answer !== "paid") toast.message(d.answer);
      else toast.success(action === "live" ? "Account is LIVE" : "Recorded");
      qc.invalidateQueries({ queryKey: ["ops:gateway-golive"] });
    },
    onError: (e: Error) => toast.error("Not done", { description: e.message }),
  });
  const live = a.status === "LIVE";
  return (
    <li className="rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium">{a.merchant_id}</span>
        <span className="text-sm">{a.gateway}</span>
        <Badge variant={live ? "success" : "warning"}>{a.status}</Badge>
        {!a.credentials_match && <Badge variant="danger">saved credentials no longer match</Badge>}
        <span className="ml-auto text-xs text-[color:var(--color-text-muted)]">
          {live ? `live ${formatDateTime(a.live_at)} by ${a.live_by ?? "—"}` : `verifying since ${formatDateTime(a.created_at)}`}
        </span>
      </div>
      {a.note && <p className="mt-1 text-xs text-[color:var(--color-text-muted)]">{a.note}</p>}
      {a.callback_url && <p className="mt-1 break-all font-mono text-xs text-[color:var(--color-text-muted)]">{a.callback_url}</p>}

      <ul className="mt-3 space-y-2">
        {a.checklist.map((i) => (
          <li key={i.key} className="flex flex-wrap items-center gap-2 text-sm">
            {i.done ? <Check className="h-4 w-4 text-[color:var(--color-success)]" /> : <Circle className="h-4 w-4 text-[color:var(--color-text-muted)]" />}
            <span>{i.label}</span>
            {(i.at || i.detail) && <span className="text-xs text-[color:var(--color-text-muted)]">{[i.detail, i.at ? formatDateTime(i.at) : null, i.by].filter(Boolean).join(" · ")}</span>}
            {!live && ACTION[i.key] && (
              <Button size="sm" variant="secondary" className="ml-auto" disabled={run.isPending} onClick={() => run.mutate(ACTION[i.key].action)}>{ACTION[i.key].label}</Button>
            )}
          </li>
        ))}
      </ul>

      {!live && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
          <Input className="h-8 min-w-[200px] flex-1" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
          <Button size="sm" disabled={!a.can_go_live || run.isPending} onClick={() => run.mutate("live")}><Rocket className="h-4 w-4" /> Set LIVE</Button>
        </div>
      )}
    </li>
  );
}

export default function GatewayGoLivePage() {
  const q = useQuery({
    queryKey: ["ops:gateway-golive"],
    queryFn: async () => {
      const r = await fetch("/api/ops/gateway-golive");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { accounts: Account[]; limits: { max_amount: number; max_orders: number } };
    },
    refetchInterval: 30_000,
  });
  const accounts = q.data?.accounts ?? [];
  const l = q.data?.limits;
  return (
    <div>
      <PageHeader title="Gateway go-live" icon={Rocket}
        description="A gateway account is set LIVE only after its callback URL answers, a real payment was reported by the gateway, and a status check confirmed the same payment." />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Accounts</CardTitle>
          <CardDescription>
            An account appears here when live credentials are saved for a banker.
            {l ? ` While it is verifying it takes at most ${l.max_orders} live payments of up to ₹${l.max_amount} each.` : ""} Accounts that were live before the checklist existed are not listed and are not restricted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {q.isLoading ? <p className="text-sm text-[color:var(--color-text-muted)]">Loading…</p>
            : q.error ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>
            : accounts.length === 0 ? <p className="py-6 text-center text-sm text-[color:var(--color-text-muted)]">No account is on the checklist.</p>
            : <ul className="space-y-3">{accounts.map((a) => <AccountCard key={a.merchant_id + a.gateway} a={a} />)}</ul>}
        </CardContent>
      </Card>
    </div>
  );
}
