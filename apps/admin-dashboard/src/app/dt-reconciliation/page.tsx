"use client";

// DT Reconciliation (BRD §9, §15). The invariant board: quota closing balance,
// commission waterfall, and reservation hygiene. Every card states the rule it checks
// so a red tile tells an operator what is actually wrong, not just that something is.

import { useQuery } from "@tanstack/react-query";
import { Scale, CheckCircle2, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { KpiTile } from "@/components/world-class/kpi-tile";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatAmount } from "@/lib/utils";

interface Recon {
  quota: { allocated: number; reserved: number; consumed: number };
  reservations: { open_reservations: number; stale_reservations: number };
  commission: { merchant_charge: number; banker_commission: number; katana_margin: number };
  available_closing: number;
  invariants: { margin_waterfall_balances: boolean; no_stale_reservations: boolean };
}

function InvariantRow({ ok, rule, detail }: { ok: boolean; rule: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 border-b border-[color:var(--color-border)] py-3 last:border-0">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-success)]" aria-hidden />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-danger)]" aria-hidden />
      )}
      <div className="min-w-0">
        <div className="text-sm font-medium">{rule}</div>
        <div className="text-xs text-[color:var(--color-text-muted)]">{detail}</div>
      </div>
      <span
        className={`ml-auto shrink-0 text-xs font-semibold ${ok ? "text-[color:var(--color-success)]" : "text-[color:var(--color-danger)]"}`}
      >
        {ok ? "PASS" : "FAIL"}
      </span>
    </div>
  );
}

export default function DtReconciliationPage() {
  const q = useQuery({
    queryKey: ["dt-reconciliation"],
    queryFn: async () => {
      const r = await fetch("/api/v1/dt/reconciliation");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as Recon;
    },
  });

  const d = q.data;
  const loading = q.isLoading;
  // BRD §15: allocated − reserved − consumed = closing. Recomputed client-side purely
  // as a cross-check that the server's arithmetic matches the stated rule.
  const closingMatches =
    d ? Math.abs((d.quota.allocated - d.quota.reserved - d.quota.consumed) - d.available_closing) < 0.01 : true;

  return (
    <>
      <PageHeader
        title="DT Reconciliation"
        description="Quota, waterfall and reservation invariants (BRD §15). Journals remain the source of truth."
        icon={Scale}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Allocated quota" value={d ? formatAmount(d.quota.allocated) : "—"} loading={loading} />
        <KpiTile label="Reserved (in flight)" value={d ? formatAmount(d.quota.reserved) : "—"} loading={loading} />
        <KpiTile label="Consumed" value={d ? formatAmount(d.quota.consumed) : "—"} loading={loading} />
        <KpiTile
          label="Available closing"
          value={d ? formatAmount(d.available_closing) : "—"}
          sublabel="allocated − reserved − consumed"
          variant={d && d.available_closing < 0 ? "danger" : "success"}
          loading={loading}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Invariants</CardTitle>
            <CardDescription>Each rule is stated as the BRD defines it.</CardDescription>
          </CardHeader>
          <CardContent>
            {loading || !d ? (
              <div className="py-6 text-sm text-[color:var(--color-text-muted)]">Checking…</div>
            ) : (
              <>
                <InvariantRow
                  ok={d.invariants.margin_waterfall_balances}
                  rule="Commission waterfall balances"
                  detail={`merchant ${formatAmount(d.commission.merchant_charge)} − banker ${formatAmount(d.commission.banker_commission)} = katana ${formatAmount(d.commission.katana_margin)}`}
                />
                <InvariantRow
                  ok={d.invariants.no_stale_reservations}
                  rule="No stale reservations"
                  detail={`${d.reservations.stale_reservations} expired of ${d.reservations.open_reservations} open — stale locks hold quota that should have been released (BRD RT-005)`}
                />
                <InvariantRow
                  ok={closingMatches}
                  rule="Quota closing balance"
                  detail="allocated − reserved − consumed equals the reported closing figure"
                />
                <InvariantRow
                  ok={d.available_closing >= 0}
                  rule="Closing balance is non-negative"
                  detail="a negative closing means quota was consumed beyond what was allocated"
                />
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Reservations</CardTitle>
            <CardDescription>In-flight quota locks (BRD §11 concurrency).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <KpiTile label="Open" value={d?.reservations.open_reservations ?? "—"} loading={loading} />
              <KpiTile
                label="Stale"
                value={d?.reservations.stale_reservations ?? "—"}
                variant={d && d.reservations.stale_reservations > 0 ? "danger" : "success"}
                loading={loading}
              />
            </div>
            <p className="text-xs text-[color:var(--color-text-muted)]">
              A reservation is taken before the provider call and must be consumed on success or
              released on failure, timeout or expiry. Anything still RESERVED past its expiry is
              holding quota that no longer corresponds to a live payment.
            </p>
            <Button variant="secondary" onClick={() => q.refetch()} disabled={q.isFetching}>
              {q.isFetching ? "Re-checking…" : "Re-run checks"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
