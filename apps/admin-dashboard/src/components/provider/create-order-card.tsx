"use client";

// Provider-side "Create S2S order" — lets a provider generate a QR / S2S pay-in on
// behalf of one of their mapped merchants. Reuses PoolPayCreateOrder, pointing it at
// the merchant-scoped endpoint (which enforces sub-MID routing + risk rules and is
// allowed for the PROVIDER persona when the merchant is mapped to them).

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { PoolPayCreateOrder } from "@/components/vendors/poolpay-create-order";

interface MerchantRow { id: string; merchant_code: string; legal_name: string; brand_name?: string; stage: string }

export function ProviderCreateOrderCard() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["pp:order-merchants"],
    queryFn: async () => (await fetch("/api/merchants").then((r) => r.json())) as { merchants: MerchantRow[] },
  });
  const merchants = q.data?.merchants ?? [];
  const [sel, setSel] = useState("");
  const selectedId = sel || merchants[0]?.id || "";
  const selected = merchants.find((m) => m.id === selectedId);

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Banknote className="h-4 w-4" /> Create a pay-in (S2S order)</CardTitle>
        <CardDescription>Generate a QR / S2S collect order on behalf of one of your branches.</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="py-4 text-center text-sm text-[color:var(--color-text-muted)]">Loading branches…</div>
        ) : merchants.length === 0 ? (
          <div className="rounded-xl border border-dashed px-3 py-5 text-center text-sm text-[color:var(--color-text-muted)]">
            No branches yet. Add one under Leads first.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[240px] flex-1 space-y-1.5">
                <Label>Branch</Label>
                <select
                  className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]"
                  value={selectedId}
                  onChange={(e) => setSel(e.target.value)}
                >
                  {merchants.map((m) => (
                    <option key={m.id} value={m.id}>{m.merchant_code} — {m.brand_name || m.legal_name} ({m.stage})</option>
                  ))}
                </select>
              </div>
              <PoolPayCreateOrder
                key={selectedId}
                endpoint={`/api/merchants/${selectedId}/payin-orders`}
                receiverPlaceholder={"leave blank to use the merchant's settlement VPA\nor add a payee pool, one per line"}
                onChange={() => qc.invalidateQueries()}
              />
            </div>
            {selected && (
              <p className="mt-2 text-xs text-[color:var(--color-text-muted)]">
                Order will be created for <span className="font-mono">{selected.merchant_code}</span> and routed through its sub-MID &amp; settlement VPA.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
