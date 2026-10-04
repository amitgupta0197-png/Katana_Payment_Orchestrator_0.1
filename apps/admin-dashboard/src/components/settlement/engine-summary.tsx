"use client";

// Merchant portal: automatic settlement per banker (Settlement Engine), read-only. What each banker
// owes on the ledger, the approved schedule, and the settlements the engine raised. Katana staff
// set the schedule; the banker still pays and the merchant still confirms in the list below it.
// API: /api/settlement-engine?banker= (a merchant sees its own bankers only).

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";

interface View {
  banker: string; paused: boolean;
  balances: { payable: string; reserve: string; in_transit: string };
  config: { version: number; body: { timing: string; weekday?: number | null; transfer_mode: string; reserve_bps: number; reserve_hold_days: number } } | null;
  instructions: { id: string; state: string; net_minor: string; gross_minor: string; utr: string | null; created_at: string }[];
}

const MUTED = "text-[color:var(--color-text-muted)]";
const inr = (p: string | number) => `₹${(Number(p) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const WHEN: Record<string, string> = { INSTANT: "Instant", ON_DEMAND: "On request", T0: "Same day (T+0)", T1: "Next day (T+1)", T2: "T+2", WEEKLY: "Weekly" };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WORD: Record<string, string> = { PENDING: "Being raised", INITIATED: "Sent to banker", IN_TRANSIT: "Paid, awaiting your confirmation", SETTLED: "Settled", FAILED: "Failed", REVERSED: "Reversed", HELD: "On hold", CANCELLED: "Cancelled" };

function BankerRow({ code, name }: { code: string; name?: string }) {
  const q = useQuery({
    queryKey: ["se:portal", code],
    queryFn: async () => { const r = await fetch(`/api/settlement-engine?banker=${encodeURIComponent(code)}`); if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as View; },
    refetchInterval: 30_000,
  });
  const v = q.data;
  if (!v) return null;
  const last = v.instructions[0];
  const b = v.config?.body;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-sm">
      <span className="font-medium">{name || code}</span>
      {b ? <Badge variant="info">{b.timing === "WEEKLY" ? `Weekly, ${DAYS[b.weekday ?? 1]}` : WHEN[b.timing] ?? b.timing} · {b.transfer_mode}</Badge> : <Badge variant="default">Not scheduled</Badge>}
      {v.paused && <Badge variant="warning">Paused</Badge>}
      <span className={MUTED}>To be settled <span className="font-medium text-[color:var(--color-text)] tabular-nums">{inr(v.balances.payable)}</span></span>
      {Number(v.balances.in_transit) > 0 && <span className={MUTED}>On its way <span className="tabular-nums">{inr(v.balances.in_transit)}</span></span>}
      {Number(v.balances.reserve) > 0 && <span className={MUTED}>Reserve <span className="tabular-nums">{inr(v.balances.reserve)}</span>{b ? ` (released after ${b.reserve_hold_days} days)` : ""}</span>}
      {last && <span className={`ml-auto text-xs ${MUTED}`}>Last: {inr(last.net_minor)} · {WORD[last.state] ?? last.state}{last.utr ? ` · UTR ${last.utr}` : ""} · {formatDateTime(last.created_at)}</span>}
    </li>
  );
}

export function EngineSettlementSummary({ bankers }: { bankers: { merchant_code: string; legal_name?: string }[] }) {
  if (!bankers.length) return null;
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Automatic settlement</CardTitle>
        <CardDescription>What each banker owes you, and when it is settled. Katana sets the schedule with you; you still confirm each payment below.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-md border">{bankers.map((b) => <BankerRow key={b.merchant_code} code={b.merchant_code} name={b.legal_name} />)}</ul>
      </CardContent>
    </Card>
  );
}
