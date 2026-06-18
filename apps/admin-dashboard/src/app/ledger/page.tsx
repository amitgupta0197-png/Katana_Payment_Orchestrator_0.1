"use client";

// L1 — ledger. Wraps three sub-views (Journals / Accounts / Balances) in
// tabs so the cockpit isn't a stack of cards. Each gets its own DataView
// with appropriate filters / search.

import { useQuery } from "@tanstack/react-query";
import { BookOpen, FileText, Wallet, BookCopy } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataView } from "@/components/world-class/data-view";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface Journal { id: string; posted_at: string; currency: string; narration?: string; ref_type: string; ref_id: string; idempotency_key: string }
interface Account { id: string; code: string; parent_code: string; type: string; currency: string; normal_balance: string; closed: boolean }
interface Balance { merchant_id: string; currency: string; balance: number }

export default function LedgerPage() {
  const journals = useQuery({
    queryKey: ["ledger:journals"],
    queryFn: async () => (await fetch("/api/ledger/journals").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { journals: Journal[] },
  });
  const accounts = useQuery({
    queryKey: ["ledger:accounts"],
    queryFn: async () => (await fetch("/api/ledger/accounts").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { accounts: Account[] },
  });
  const balances = useQuery({
    queryKey: ["ledger:balances"],
    queryFn: async () => (await fetch("/api/ledger/balance").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { balances: Balance[] },
  });

  const jRows = journals.data?.journals ?? [];
  const aRows = accounts.data?.accounts ?? [];
  const bRows = balances.data?.balances ?? [];

  const jCols: Column<Journal>[] = [
    { key: "posted_at", header: "Posted", render: (r) => <span className="text-xs">{formatDateTime(r.posted_at)}</span> },
    { key: "ref_type", header: "Ref", render: (r) => <Badge variant="brand">{r.ref_type}</Badge> },
    { key: "ref_id", header: "Ref ID", render: (r) => <span className="font-mono text-xs">{r.ref_id}</span> },
    { key: "narration", header: "Narration", render: (r) => r.narration ?? "—" },
    { key: "currency", header: "Cur" },
    { key: "idempotency_key", header: "Idem", render: (r) => <span className="font-mono text-xs">{(r.idempotency_key ?? "").slice(0, 16)}…</span> },
  ];
  const aCols: Column<Account>[] = [
    { key: "code", header: "Code", render: (r) => <span className="font-mono text-xs">{r.code}</span> },
    { key: "type", header: "Type", render: (r) => <Badge variant="info">{r.type}</Badge> },
    { key: "normal_balance", header: "Normal" },
    { key: "currency", header: "Cur" },
    { key: "parent_code", header: "Parent", render: (r) => r.parent_code ? <span className="font-mono text-xs">{r.parent_code}</span> : "—" },
    { key: "closed", header: "Closed", render: (r) => r.closed ? <Badge variant="warning">closed</Badge> : <Badge variant="success">open</Badge> },
  ];
  const bCols: Column<Balance>[] = [
    { key: "merchant_id", header: "Merchant" },
    { key: "currency", header: "Cur" },
    { key: "balance", header: "Balance", render: (r) => <span className="tabular-nums font-medium">{formatAmount(r.balance, r.currency)}</span> },
  ];

  return (
    <>
      <PageHeader title="Ledger" description="Double-entry journal, account map, and merchant balances." icon={BookOpen} />
      <Tabs defaultValue="journals">
        <TabsList>
          <TabsTrigger value="journals"><FileText className="h-3.5 w-3.5" /> Journals
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{jRows.length}</span>
          </TabsTrigger>
          <TabsTrigger value="accounts"><BookCopy className="h-3.5 w-3.5" /> Accounts
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{aRows.length}</span>
          </TabsTrigger>
          <TabsTrigger value="balances"><Wallet className="h-3.5 w-3.5" /> Balances
            <span className="ml-1 rounded-full bg-[color:var(--color-surface-muted)] px-1.5 text-xs">{bRows.length}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="journals">
          <DataView
            rows={jRows} columns={jCols} rowKey={(r) => r.id} loading={journals.isLoading}
            search={{ placeholder: "Search by ref / narration / idempotency…", fields: ["ref_type", "ref_id", "narration", "idempotency_key"] }}
            filters={Array.from(new Set(jRows.map((j) => j.ref_type))).slice(0, 6).map((rt) => ({ key: `rt-${rt}`, label: rt, predicate: (r: Journal) => r.ref_type === rt }))}
            savedViewKey="ledger-journals"
            refresh={() => journals.refetch()}
            emptyTitle="No journal entries" emptyDescription="Postings appear here as soon as the ledger receives them."
          />
        </TabsContent>
        <TabsContent value="accounts">
          <DataView
            rows={aRows} columns={aCols} rowKey={(r) => r.id} loading={accounts.isLoading}
            search={{ placeholder: "Search by code / parent…", fields: ["code", "parent_code", "type"] }}
            filters={[
              { key: "open",   label: "Open",   predicate: (r: Account) => !r.closed },
              { key: "closed", label: "Closed", predicate: (r: Account) => r.closed },
              { key: "asset",  label: "ASSET",  predicate: (r: Account) => r.type === "ASSET" },
              { key: "liab",   label: "LIABILITY", predicate: (r: Account) => r.type === "LIABILITY" },
              { key: "rev",    label: "REVENUE", predicate: (r: Account) => r.type === "REVENUE" },
              { key: "exp",    label: "EXPENSE", predicate: (r: Account) => r.type === "EXPENSE" },
            ]}
            savedViewKey="ledger-accounts"
            refresh={() => accounts.refetch()}
            emptyTitle="No accounts" emptyDescription="Seed the chart of accounts before posting journals."
          />
        </TabsContent>
        <TabsContent value="balances">
          <DataView
            rows={bRows} columns={bCols} rowKey={(r) => `${r.merchant_id}-${r.currency}`} loading={balances.isLoading}
            search={{ placeholder: "Search by merchant…", fields: ["merchant_id", "currency"] }}
            savedViewKey="ledger-balances"
            refresh={() => balances.refetch()}
            emptyTitle="No balances yet"
          />
        </TabsContent>
      </Tabs>
    </>
  );
}
