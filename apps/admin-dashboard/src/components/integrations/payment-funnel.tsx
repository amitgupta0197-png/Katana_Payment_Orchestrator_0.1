"use client";

// Shared PoolPay (Katana Pay) reconciliation funnel. One component renders the
// same pipeline on the provider dashboard, the branch dashboard, and the admin
// provider-detail Integration tab — all reading /api/integrations/poolpay/funnel.
//
// Pass a scope:
//   <PaymentFunnel />                        // caller's own scope (provider/branch/global)
//   <PaymentFunnel providerId="…" />          // a provider's whole portfolio
//   <PaymentFunnel merchant="MID123" />       // a single branch

import { useQuery } from "@tanstack/react-query";
import { Activity, CheckCircle2, Clock, AlertTriangle, XCircle, TimerOff, Layers } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatAmount } from "@/lib/utils";

interface Stage { key: string; label: string; count: number; amount: number }
interface Funnel {
  scope: { type: string; id: string | null };
  totals: { count: number; amount: number };
  stages: Stage[];
  settled_count: number;
  needs_action: number;
  conversion_pct: number | null;
}

const ICON: Record<string, typeof Activity> = {
  created: Layers, pending: Clock, needs_action: AlertTriangle,
  success: CheckCircle2, failed: XCircle, expired: TimerOff,
};
const TONE: Record<string, string> = {
  created: "text-[color:var(--color-text-muted)]",
  pending: "text-[color:var(--color-brand)]",
  needs_action: "text-[color:var(--color-warning)]",
  success: "text-[color:var(--color-success)]",
  failed: "text-[color:var(--color-danger)]",
  expired: "text-[color:var(--color-text-subtle)]",
};

export function PaymentFunnel({
  providerId, merchant, title = "Reconciliation funnel",
  description = "Katana Pay pay-ins from created → reconciled.", refetchMs = 30_000,
}: {
  providerId?: string; merchant?: string; title?: string; description?: string; refetchMs?: number;
}) {
  const qs = new URLSearchParams();
  if (providerId) qs.set("provider", providerId);
  if (merchant) qs.set("merchant", merchant);
  const suffix = qs.toString() ? `?${qs}` : "";

  const q = useQuery({
    queryKey: ["poolpay-funnel", providerId ?? null, merchant ?? null],
    queryFn: async () => (await fetch(`/api/integrations/poolpay/funnel${suffix}`).then(async (r) => {
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || ("HTTP " + r.status));
      return d;
    })) as Funnel,
    refetchInterval: refetchMs,
  });

  const f = q.data;
  const total = f?.totals.count ?? 0;

  return (
    <Card className="mb-6">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {f?.needs_action ? <Badge variant="warning">{f.needs_action} need action</Badge> : null}
          {f?.conversion_pct !== null && f?.conversion_pct !== undefined && (
            <Badge variant={f.conversion_pct >= 90 ? "success" : f.conversion_pct >= 70 ? "info" : "warning"}>
              {f.conversion_pct}% success
            </Badge>
          )}
          <Badge variant={q.isFetching ? "info" : "default"}><Activity className="h-3 w-3 mr-1" />live</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {q.isError ? (
          <div className="py-6 text-center text-sm text-[color:var(--color-danger)]">
            Couldn’t load funnel: {(q.error as Error)?.message}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
              {(f?.stages ?? STAGE_SKELETON).map((st) => {
                const Icon = ICON[st.key] ?? Activity;
                const pct = total > 0 && st.key !== "created" ? Math.round((st.count / total) * 100) : null;
                const active = st.count > 0;
                return (
                  <div
                    key={st.key}
                    className={`rounded-lg border p-3 ${active ? "bg-[color:var(--color-surface-muted)]" : ""}`}
                  >
                    <div className="flex items-center gap-1.5">
                      <Icon className={`h-3.5 w-3.5 ${TONE[st.key] ?? ""}`} />
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)]">{st.label}</span>
                    </div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums">{q.isLoading ? "—" : st.count}</div>
                    <div className="text-xs text-[color:var(--color-text-muted)] tabular-nums">{formatAmount(st.amount)}</div>
                    {pct !== null && <div className="mt-0.5 text-[10px] text-[color:var(--color-text-subtle)]">{pct}% of created</div>}
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[color:var(--color-text-muted)]">
              <span>Total <span className="font-medium text-[color:var(--color-text)]">{total}</span> pay-ins</span>
              <span>·</span>
              <span>Settled <span className="font-medium text-[color:var(--color-text)]">{f?.settled_count ?? 0}</span></span>
              {f?.scope?.type && <><span>·</span><span>scope: {f.scope.type}</span></>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const STAGE_SKELETON: Stage[] = [
  { key: "created", label: "Created", count: 0, amount: 0 },
  { key: "pending", label: "Pending", count: 0, amount: 0 },
  { key: "needs_action", label: "Needs action", count: 0, amount: 0 },
  { key: "success", label: "Success", count: 0, amount: 0 },
  { key: "failed", label: "Failed", count: 0, amount: 0 },
  { key: "expired", label: "Expired", count: 0, amount: 0 },
];
