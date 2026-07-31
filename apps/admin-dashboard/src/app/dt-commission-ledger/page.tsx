"use client";

// Commission Ledger (BRD §9, §14). Per-transaction accrual of the three-party
// waterfall: merchant_charge − banker_commission = katana_margin. Reversals appear as
// linked negative adjustments (BRD §14 "Reversal"), flagged so a refund is never
// mistaken for fresh revenue.

import { useQuery } from "@tanstack/react-query";
import { Percent, TrendingDown } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { DataView } from "@/components/world-class/data-view";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { formatDateTime, formatAmount } from "@/lib/utils";

interface Entry {
  id: string; transaction_ref: string; base_amount: number;
  merchant_charge: number; banker_commission: number; katana_margin: number;
  rule_version: string | null; is_reversal: boolean; created_at: string;
}
interface Totals { merchant_charge: number; banker_commission: number; katana_margin: number }

export default function DtCommissionLedgerPage() {
  const q = useQuery({
    queryKey: ["dt-commission-ledger"],
    queryFn: async () => {
      const r = await fetch("/api/v1/dt/commission-ledger");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as { entries: Entry[]; totals: Totals };
    },
  });

  const t = q.data?.totals;
  // BRD §15 invariant: merchant − banker = katana. Surfacing it here means a broken
  // waterfall is visible on the screen that shows the money, not only in reconciliation.
  const waterfallOk =
    t ? Math.abs((t.merchant_charge - t.banker_commission) - t.katana_margin) < 0.01 : true;

  const cols: Column<Entry>[] = [
    {
      key: "transaction_ref",
      header: "Transaction",
      render: (r) => (
        <span className="flex items-center gap-2 font-medium">
          {r.transaction_ref || "—"}
          {r.is_reversal && (
            <Badge variant="danger" className="gap-1">
              <TrendingDown className="h-3 w-3" aria-hidden />
              reversal
            </Badge>
          )}
        </span>
      ),
    },
    { key: "base_amount", header: "Eligible base", render: (r) => formatAmount(r.base_amount) },
    { key: "merchant_charge", header: "Merchant 5.75%", render: (r) => formatAmount(r.merchant_charge) },
    { key: "banker_commission", header: "Banker 4.50%", render: (r) => formatAmount(r.banker_commission) },
    {
      key: "katana_margin",
      header: "Katana 1.25%",
      render: (r) => <span className="font-medium text-[color:var(--color-success)]">{formatAmount(r.katana_margin)}</span>,
    },
    { key: "rule_version", header: "Rule ver.", render: (r) => r.rule_version || "—" },
    { key: "created_at", header: "Accrued", render: (r) => formatDateTime(r.created_at) },
  ];

  return (
    <>
      <PageHeader
        title="Commission Ledger"
        description="Per-transaction commission accrual — the merchant / banker / Katana waterfall (BRD §14)."
        icon={Percent}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Merchant charged" value={t ? formatAmount(t.merchant_charge) : "—"} loading={q.isLoading} />
        <KpiTile label="Banker commission" value={t ? formatAmount(t.banker_commission) : "—"} loading={q.isLoading} />
        <KpiTile label="Katana margin" value={t ? formatAmount(t.katana_margin) : "—"} variant="success" loading={q.isLoading} />
        <KpiTile
          label="Waterfall balances"
          value={waterfallOk ? "Balanced" : "MISMATCH"}
          sublabel="merchant − banker = katana"
          variant={waterfallOk ? "success" : "danger"}
          loading={q.isLoading}
        />
      </div>

      <DataView
        rows={q.data?.entries ?? []}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search transaction ref…", fields: ["transaction_ref", "rule_version"] }}
        filters={[{ key: "reversals", label: "Reversals", predicate: (r) => r.is_reversal }]}
        refresh={() => q.refetch()}
        emptyTitle="No commission entries"
        emptyDescription="Accruals appear once the DT engine processes eligible successful traffic."
      />
    </>
  );
}
