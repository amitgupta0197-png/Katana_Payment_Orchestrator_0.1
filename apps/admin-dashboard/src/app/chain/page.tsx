"use client";

// The chain: Bank → TSP → Banker → Katana → Merchant, for a merchant (all its bankers) or one
// banker, with a colour per node and per flow the MIDs and callback URL (lib/integration-store,
// /api/merchants/{id}/integration/chain). Staff only: it names TSPs, gateways' companies; the API
// refuses any merchant or banker login, and this page shows nothing to one.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Network, Printer } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSeesGatewayNames } from "@/lib/use-access";
import { FLOW_LABEL, type Band } from "@/lib/integration";
import type { BankerChainView, ChainView } from "@/lib/integration-store";

const BAND_COLOR: Record<Band, string> = {
  GREEN: "var(--color-success)", AMBER: "var(--color-warning)", RED: "var(--color-danger)", GREY: "var(--color-text-subtle)",
};
const BAND_WORD: Record<Band, string> = { GREEN: "good", AMBER: "needs a look", RED: "broken", GREY: "not set up" };
const muted = "text-[color:var(--color-text-muted)]";
const selectCls = "flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]";

async function call<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
  return d as T;
}

export default function ChainPage() {
  const staff = useSeesGatewayNames();
  const [pick, setPick] = useState("");   // "provider:<id>" | "banker:<id>"
  const providersQ = useQuery({ queryKey: ["chain", "providers"], enabled: staff,
    queryFn: () => call<{ providers: { id: string; code: string; legal_name: string }[] }>("/api/providers") });
  const bankersQ = useQuery({ queryKey: ["chain", "bankers"], enabled: staff,
    queryFn: () => call<{ merchants: { id: string; merchant_code: string; legal_name: string; brand_name?: string }[] }>("/api/merchants") });
  const [kind, id] = pick.split(":");
  const chainQ = useQuery({
    queryKey: ["chain", pick], enabled: staff && !!id,
    queryFn: () => call<ChainView>(`/api/merchants/${id}/integration/chain${kind === "provider" ? "?kind=provider" : ""}`),
  });

  if (!staff) {
    return <Card><CardContent className={`py-8 text-center text-sm ${muted}`}>This page is for Katana staff.</CardContent></Card>;
  }
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <style>{`@media print { nav, aside, header, .no-print { display: none !important; } .chain-print { break-inside: avoid; } }`}</style>
      <PageHeader title="Chain" description="Where each banker's money comes from and goes to, and what is not working." icon={Network} />
      <Card className="no-print">
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <div className="min-w-64 flex-1">
            <label className={`mb-1 block text-xs ${muted}`} htmlFor="chain-pick">Merchant or banker</label>
            <select id="chain-pick" className={selectCls} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose…</option>
              <optgroup label="Merchants (all their bankers)">
                {(providersQ.data?.providers ?? []).map((p) => <option key={p.id} value={`provider:${p.id}`}>{p.legal_name} ({p.code})</option>)}
              </optgroup>
              <optgroup label="Bankers">
                {(bankersQ.data?.merchants ?? []).map((m) => <option key={m.id} value={`banker:${m.id}`}>{m.brand_name || m.legal_name} ({m.merchant_code})</option>)}
              </optgroup>
            </select>
          </div>
          <Button variant="secondary" disabled={!chainQ.data} onClick={() => window.print()}><Printer className="h-4 w-4" /> Print</Button>
        </CardContent>
      </Card>
      <Legend />
      {!id && <p className={`text-sm ${muted}`}>Choose a merchant or a banker to see its chain.</p>}
      {chainQ.isLoading && id && <p className={`text-sm ${muted}`}>Loading…</p>}
      {chainQ.error && <p className="text-sm text-[color:var(--color-danger)]">Could not load: {(chainQ.error as Error).message}</p>}
      {chainQ.data && chainQ.data.bankers.length === 0 && <p className={`text-sm ${muted}`}>This merchant has no bankers.</p>}
      {chainQ.data?.bankers.map((b) => <ChainRow key={b.banker.id} b={b} />)}
    </div>
  );
}

function Legend() {
  return (
    <div className={`flex flex-wrap gap-4 text-xs ${muted}`}>
      {(Object.keys(BAND_COLOR) as Band[]).map((b) => (
        <span key={b} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: BAND_COLOR[b] }} aria-hidden />{BAND_WORD[b]}
        </span>
      ))}
    </div>
  );
}

function Dot({ band }: { band: Band }) {
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: BAND_COLOR[band] }} title={BAND_WORD[band]} />;
}

function ChainRow({ b }: { b: BankerChainView }) {
  const shown = useMemo(() => b.flows.filter((f) => f.active || f.mids_active || f.mids_pending || f.callback_source === "FLOW"), [b.flows]);
  return (
    <Card className="chain-print">
      <CardContent className="space-y-4 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-medium">{b.banker.name} <span className={`font-mono text-xs ${muted}`}>{b.banker.code}</span></div>
          <Link className="no-print text-xs text-[color:var(--color-brand)] hover:underline" href={`/bankers/${b.banker.id}?tab=integration`}>Integration</Link>
        </div>
        <ol className="flex flex-col items-stretch gap-2 md:flex-row md:items-center">
          {b.nodes.map((n, i) => (
            <li key={n.kind} className="flex flex-1 flex-col items-stretch gap-2 md:flex-row md:items-center">
              {(() => {
                const body = (
                  <div className="h-full rounded-lg border-2 p-3" style={{ borderColor: BAND_COLOR[n.band] }}>
                    <div className={`flex items-center gap-1.5 text-xs uppercase tracking-wide ${muted}`}><Dot band={n.band} />{n.title}</div>
                    <div className="mt-1 truncate text-sm font-medium">{n.label}</div>
                    <div className={`truncate text-xs ${muted}`}>{n.sub}</div>
                  </div>
                );
                return n.href ? <Link href={n.href} className="min-w-0 flex-1 hover:opacity-90">{body}</Link> : <div className="min-w-0 flex-1">{body}</div>;
              })()}
              {i < b.nodes.length - 1 && <ArrowRight className={`mx-auto h-4 w-4 shrink-0 rotate-90 md:rotate-0 ${muted}`} aria-hidden />}
            </li>
          ))}
        </ol>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className={`text-left text-xs ${muted}`}>
              <tr><th className="py-1 pr-3 font-normal">Flow</th><th className="py-1 pr-3 font-normal">MIDs</th><th className="py-1 pr-3 font-normal">Callback URL</th><th className="py-1 font-normal">Score</th></tr>
            </thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={4} className={`py-2 ${muted}`}>No flow in use.</td></tr>}
              {shown.map((f) => (
                <tr key={f.flow} className="border-t">
                  <td className="py-1.5 pr-3">{FLOW_LABEL[f.flow]}{!f.active && <span className={`text-xs ${muted}`}> (not on it)</span>}</td>
                  <td className="py-1.5 pr-3"><span className="inline-flex items-center gap-1.5"><Dot band={f.mid_band} />
                    {f.mids_active} active{f.mids_pending ? `, ${f.mids_pending} waiting` : ""}{f.flow === "P2P" && !f.mids_active ? " (UPI ID, none needed)" : ""}</span></td>
                  <td className="py-1.5 pr-3"><span className="inline-flex items-center gap-1.5"><Dot band={f.callback_band} />
                    {f.callback_source ? `${f.callback_source === "FLOW" ? "own URL" : "default URL"}, ${(f.callback_status ?? "not checked").toLowerCase()}` : "none"}</span></td>
                  <td className="py-1.5"><span className="inline-flex items-center gap-1.5"><Dot band={f.score_band} />{f.score}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
