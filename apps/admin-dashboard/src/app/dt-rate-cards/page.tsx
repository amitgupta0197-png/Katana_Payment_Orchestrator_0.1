"use client";

// DT Rate Cards (BRD §9, §5). The Katana-controlled price per DT unit, versioned and
// effective-dated. Rates are never edited in place — a new version supersedes the old
// one, so a historic advance stays priced at the rate it was actually bought at.

import { useQuery } from "@tanstack/react-query";
import { Sliders, CheckCircle2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { DataView } from "@/components/world-class/data-view";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { Column } from "@/components/ui/data-table";
import { formatDateTime, formatAmount } from "@/lib/utils";

interface RateCard {
  id: string; currency: string; rate: number; effective_from: string; effective_to: string | null;
  status: string; version: number; created_by: string; created_at: string; lots_at_rate: number;
}

const STATUS_VARIANT: Record<string, "default" | "info" | "warning" | "success" | "danger"> = {
  ACTIVE: "success", DRAFT: "warning", EXPIRED: "default", SUPERSEDED: "info",
};

export default function DtRateCardsPage() {
  const q = useQuery({
    queryKey: ["dt-rate-cards"],
    queryFn: async () => {
      const r = await fetch("/api/v1/dt/rates");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as { cards: RateCard[]; current: { rate: number; currency: string; version: number } | null };
    },
  });

  const cards = q.data?.cards ?? [];
  const current = q.data?.current ?? null;

  const cols: Column<RateCard>[] = [
    {
      key: "version",
      header: "Version",
      render: (r) => (
        <span className="flex items-center gap-2 font-medium">
          v{r.version}
          {r.status === "ACTIVE" && <CheckCircle2 className="h-3.5 w-3.5 text-[color:var(--color-success)]" aria-hidden />}
        </span>
      ),
    },
    { key: "rate", header: "Rate / DT", render: (r) => <span className="font-medium">{formatAmount(r.rate)}</span> },
    { key: "currency", header: "Currency", render: (r) => r.currency },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>{r.status}</Badge> },
    { key: "effective_from", header: "Effective from", render: (r) => formatDateTime(r.effective_from) },
    {
      key: "effective_to",
      header: "Effective to",
      render: (r) => (r.effective_to ? formatDateTime(r.effective_to) : <span className="text-[color:var(--color-text-subtle)]">open</span>),
    },
    { key: "lots_at_rate", header: "Lots priced", render: (r) => r.lots_at_rate || "—" },
    { key: "created_by", header: "Set by", render: (r) => r.created_by || "—" },
  ];

  return (
    <>
      <PageHeader
        title="DT Rate Cards"
        description="Versioned, effective-dated DT pricing (BRD §5). Set the live rate from the DT Dashboard."
        icon={Sliders}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <KpiTile
          label="Current rate"
          value={current ? formatAmount(current.rate) : "— not set —"}
          sublabel={current ? `v${current.version} · ${current.currency}` : "no ACTIVE rate card"}
          variant={current ? "success" : "danger"}
          loading={q.isLoading}
        />
        <KpiTile label="Versions" value={cards.length || "—"} loading={q.isLoading} />
        <KpiTile
          label="Superseded"
          value={cards.filter((c) => c.status !== "ACTIVE").length || "—"}
          loading={q.isLoading}
        />
      </div>

      {!q.isLoading && !current && (
        <Card className="mb-5 border-[color:var(--color-danger)]">
          <CardContent className="pt-6 text-sm">
            <span className="font-medium text-[color:var(--color-danger)]">No active rate card.</span>{" "}
            Purchases and refills cannot be priced until a rate is set — do it on the DT Dashboard.
          </CardContent>
        </Card>
      )}

      <DataView
        rows={cards}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search by status or setter…", fields: ["status", "created_by", "currency"] }}
        filters={[{ key: "active", label: "Active", predicate: (r) => r.status === "ACTIVE" }]}
        refresh={() => q.refetch()}
        emptyTitle="No rate cards"
        emptyDescription="Set the first DT rate from the DT Dashboard."
      />
    </>
  );
}
