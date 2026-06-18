"use client";

import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAmount } from "@/lib/utils";

interface MerchantRow { id: string; merchant_code: string; stage: string }
interface SubMidRow { id: string; sub_mid_code: string; kyc_status: string; settlement_enabled: boolean }
interface KybRow { id: string; status: string }

export default function ProviderDashboard() {
  const merchants = useQuery({
    queryKey: ["pp:merchants"],
    queryFn: async () => (await fetch("/api/merchants").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { merchants: MerchantRow[] },
  });
  const subMids = useQuery({
    queryKey: ["pp:sub-mids"],
    queryFn: async () => (await fetch("/api/sub-mids").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { sub_mids: SubMidRow[] },
  });
  const commission = useQuery({
    queryKey: ["pp:commission"],
    queryFn: async () => (await fetch("/api/commission").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { mtd_earned: number; ytd_earned: number },
  });
  const kyb = useQuery({
    queryKey: ["pp:kyb"],
    queryFn: async () => (await fetch("/api/kyb").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { cases: KybRow[] },
  });

  const subs = subMids.data?.sub_mids ?? [];
  const tiles = [
    { label: "Mapped merchants", value: merchants.data?.merchants?.length ?? 0 },
    { label: "Sub-MIDs pending KYC", value: subs.filter((s) => s.kyc_status === "PENDING").length },
    { label: "Sub-MIDs live", value: subs.filter((s) => s.settlement_enabled).length },
    { label: "MTD commission earned", value: formatAmount(commission.data?.mtd_earned ?? 0) },
    { label: "Open KYB cases", value: (kyb.data?.cases ?? []).filter((c) => c.status !== "APPROVED" && c.status !== "REJECTED").length },
  ];

  return (
    <>
      <PageHeader
        title="Provider dashboard"
        description="Your mapped merchants, Sub-MID requests, KYC progress, and commission."
        icon={LayoutDashboard}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {tiles.map((t) => (
          <Card key={t.label}>
            <CardHeader>
              <CardDescription>{t.label}</CardDescription>
              <CardTitle className="text-2xl">{t.value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Recent activity</CardTitle>
          <CardDescription>Last events on mapped merchants (workflow_transitions). Empty until the events service ships.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-[color:var(--color-text-muted)]">No activity yet.</p>
        </CardContent>
      </Card>
    </>
  );
}
