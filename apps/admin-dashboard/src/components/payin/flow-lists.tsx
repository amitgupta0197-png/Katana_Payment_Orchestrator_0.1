"use client";

// The merchant and banker lists of the Pay-in Flows module: who is on which flow, with the
// control to change it. Used by the overview (every flow) and by the P2P and Intent
// sub-modules (that flow only).

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Column } from "@/components/ui/data-table";
import { DataView } from "@/components/world-class/data-view";
import { FlowBadge, FlowSelectDialog, type FlowTarget } from "@/components/payin/flow";
import type { MerchantFlow, OrderFlow, PayinFlowSetting } from "@/lib/payin-flow";

export interface FlowMerchant extends MerchantFlow { id: string; code: string; name: string; status: string; bankers: number; set_at: string | null }
export interface FlowBanker extends MerchantFlow {
  id: string; merchant_code: string; name: string; stage: string;
  provider_id: string | null; provider_name: string | null;
  source: "BANKER" | "MERCHANT" | "NONE"; readiness: { p2p: boolean; intent: boolean };
}
export interface FlowsData {
  flow: OrderFlow | null;
  counts: { merchants: Record<PayinFlowSetting, number>; bankers: Record<PayinFlowSetting, number> };
  merchants: FlowMerchant[]; bankers: FlowBanker[];
  /** Pay-out only merchants and their bankers, left out of both lists. */
  payout_only?: { merchants: number; bankers: number };
}

/** The bifurcation, optionally narrowed to one flow (Both counts under each). */
export function useFlows(flow?: OrderFlow) {
  return useQuery({
    queryKey: ["payin-flows", flow ?? "ALL"],
    queryFn: async () => {
      const r = await fetch(`/api/payin-flows${flow ? `?flow=${flow}` : ""}`);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error ?? "Could not load pay-in flows");
      return d as FlowsData;
    },
  });
}

const FLOW_FILTERS = <T extends MerchantFlow>() => [
  { key: "p2p", label: "P2P", predicate: (r: T) => r.flow === "P2P" },
  { key: "intent", label: "Intent", predicate: (r: T) => r.flow === "INTENT" },
  { key: "both", label: "Both", predicate: (r: T) => r.flow === "BOTH" },
  { key: "unset", label: "Not selected", predicate: (r: T) => r.flow === "UNSET" },
];

export function FlowMerchantsTable({ rows, loading, refresh, viewKey, showFilters }: {
  rows: FlowMerchant[]; loading?: boolean; refresh: () => void; viewKey: string; showFilters?: boolean;
}) {
  const [edit, setEdit] = useState<FlowMerchant | null>(null);
  const cols: Column<FlowMerchant>[] = [
    { key: "name", header: "Merchant", render: (r) => <Link className="font-medium text-[color:var(--color-brand)] hover:underline" href={`/merchants/${r.id}`}>{r.name}</Link> },
    { key: "code", header: "Code", render: (r) => <span className="font-mono text-xs">{r.code}</span> },
    { key: "flow", header: "Pay-in flow", render: (r) => <FlowBadge flow={r.flow} active={r.active} /> },
    { key: "bankers", header: "Bankers", render: (r) => <span className="tabular-nums">{r.bankers}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={r.status === "ACTIVE" ? "success" : "warning"}>{r.status}</Badge> },
  ];
  return (
    <>
      <DataView
        rows={rows} columns={cols} rowKey={(r) => r.id} loading={loading}
        search={{ placeholder: "Search merchants…", fields: ["name", "code"] }}
        filters={showFilters ? FLOW_FILTERS<FlowMerchant>() : []}
        rowActions={(r) => <Button variant="secondary" onClick={() => setEdit(r)}>Select flow</Button>}
        savedViewKey={viewKey} refresh={refresh}
        emptyTitle="No merchants on this flow" emptyDescription="Select a pay-in flow for a merchant to list it here."
      />
      {edit && (
        <FlowSelectDialog open onOpenChange={(v) => { if (!v) setEdit(null); }}
          target={{ kind: "merchant", id: edit.id, name: edit.name } satisfies FlowTarget}
          current={{ flow: edit.flow, active: edit.active }} />
      )}
    </>
  );
}

const SOURCE: Record<FlowBanker["source"], string> = { BANKER: "own", MERCHANT: "from merchant", NONE: "" };

export function FlowBankersTable({ rows, loading, refresh, viewKey, showFilters, flow }: {
  rows: FlowBanker[]; loading?: boolean; refresh: () => void; viewKey: string; showFilters?: boolean;
  /** In a flow's own module, only that flow's readiness is shown. */
  flow?: OrderFlow;
}) {
  const [edit, setEdit] = useState<FlowBanker | null>(null);
  const ready = (ok: boolean, need: string) => ok ? <Badge variant="success">Ready</Badge> : <Badge variant="warning">{need}</Badge>;
  const cols: Column<FlowBanker>[] = [
    { key: "name", header: "Banker", render: (r) => <Link className="font-medium text-[color:var(--color-brand)] hover:underline" href={`/bankers/${r.id}`}>{r.name}</Link> },
    { key: "merchant_code", header: "Code", render: (r) => <span className="font-mono text-xs">{r.merchant_code}</span> },
    { key: "provider_name", header: "Merchant", render: (r) => r.provider_name ?? <span className="text-[color:var(--color-text-muted)]">not mapped</span> },
    { key: "flow", header: "Pay-in flow", render: (r) => (
      <span className="inline-flex items-center gap-2">
        <FlowBadge flow={r.flow} active={r.active} />
        {SOURCE[r.source] && <span className="text-xs text-[color:var(--color-text-muted)]">{SOURCE[r.source]}</span>}
      </span>
    ) },
    ...(flow !== "INTENT" ? [{ key: "p2p_ready", header: "P2P setup", render: (r: FlowBanker) => ready(r.readiness.p2p, "No settlement UPI ID") }] : []),
    ...(flow !== "P2P" ? [{ key: "intent_ready", header: "Intent setup", render: (r: FlowBanker) => ready(r.readiness.intent, "No gateway connected") }] : []),
  ];
  // What the dialog edits is the banker's OWN setting; one that comes from the merchant is not its own.
  const ownOf = (b: FlowBanker): MerchantFlow => (b.source === "BANKER" ? { flow: b.flow, active: b.active } : { flow: "UNSET", active: null });
  const inheritedOf = (b: FlowBanker): MerchantFlow => (b.source === "MERCHANT" ? { flow: b.flow, active: b.active } : { flow: "UNSET", active: null });
  return (
    <>
      <DataView
        rows={rows} columns={cols} rowKey={(r) => r.id} loading={loading}
        search={{ placeholder: "Search bankers…", fields: ["name", "merchant_code", (r) => r.provider_name ?? ""] }}
        filters={[
          ...(showFilters ? FLOW_FILTERS<FlowBanker>() : []),
          { key: "not-ready", label: "Setup missing", predicate: (r: FlowBanker) =>
              ((r.flow === "P2P" || r.flow === "BOTH") && !r.readiness.p2p) || ((r.flow === "INTENT" || r.flow === "BOTH") && !r.readiness.intent) },
          { key: "own", label: "Own flow", predicate: (r: FlowBanker) => r.source === "BANKER" },
        ]}
        rowActions={(r) => <Button variant="secondary" onClick={() => setEdit(r)}>Select flow</Button>}
        savedViewKey={viewKey} refresh={refresh}
        emptyTitle="No bankers on this flow" emptyDescription="A banker takes its merchant's flow, or one selected for it here."
      />
      {edit && (
        <FlowSelectDialog open onOpenChange={(v) => { if (!v) setEdit(null); }}
          target={{ kind: "banker", id: edit.id, name: edit.name } satisfies FlowTarget}
          current={ownOf(edit)} inherited={inheritedOf(edit)} />
      )}
    </>
  );
}
