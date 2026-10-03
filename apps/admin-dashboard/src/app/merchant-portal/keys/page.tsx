"use client";

// Key + Salt for each of the merchant's bankers, in the main menu, with what the merchant's developer
// has to build (components/merchant/developer-checklist) and each banker's Starter Kit, the same
// instructions tailored to that banker (lib/starter-kit). The key card is the one on the Integration
// page and each banker's own page: a test pair at any time, the live pair once the banker is live;
// the Salt is shown once, when it is made.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { MerchantCheckoutKeyCard } from "@/components/merchant/checkout-key-card";
import { StarterKitCard } from "@/components/merchant/starter-kit-card";
import { DeveloperChecklist } from "@/components/merchant/developer-checklist";

interface Banker { id: string; merchant_code: string; legal_name?: string; brand_name?: string }

export default function MerchantKeysPage() {
  const q = useQuery({
    queryKey: ["mp:keys-bankers"],
    queryFn: async () => {
      const r = await fetch("/api/merchants");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as { merchants: Banker[] };
    },
  });
  const bankers = q.data?.merchants ?? [];
  const name = (b: Banker) => b.brand_name || b.legal_name || b.merchant_code;

  return (
    <>
      <PageHeader
        title="Key + Salt"
        description="Generate the Key and Salt your developers sign requests with, for each of your bankers, and see what they need to build. Copy the Salt when it is shown; it is not shown again."
        icon={KeyRound}
      />

      {q.isLoading && <p className="mb-4 text-sm text-[color:var(--color-text-muted)]">Loading your bankers…</p>}
      {q.isError && <p className="mb-4 text-sm text-[color:var(--color-danger)]">Could not load your bankers: {(q.error as Error).message}</p>}
      {q.isSuccess && !bankers.length && (
        <Card className="mb-4"><CardContent className="p-4 text-sm">
          No banker is set up under this account yet, so there is nothing to issue a Key for. Add one under{" "}
          <Link className="text-[color:var(--color-brand)] hover:underline" href="/merchant-portal/bankers">Bankers</Link>, or ask your Katana account manager.
        </CardContent></Card>
      )}

      {bankers.map((b) => (
        <section key={b.id} className="mb-6">
          {bankers.length > 1 && (
            <h2 className="mb-2 text-sm font-semibold">{name(b)} <span className="font-mono text-xs font-normal text-[color:var(--color-text-muted)]">{b.merchant_code}</span></h2>
          )}
          <MerchantCheckoutKeyCard merchantId={b.id} merchantCode={b.merchant_code} />
        </section>
      ))}

      {bankers.length > 0 && <DeveloperChecklist />}

      {bankers.map((b) => (
        <section key={`kit-${b.id}`} className="mb-6">
          <h2 className="mb-2 text-sm font-semibold">Send to your developer{bankers.length > 1 ? `: ${name(b)}` : ""}</h2>
          <StarterKitCard merchantId={b.id} />
        </section>
      ))}

      <p className="mt-2 text-sm text-[color:var(--color-text-muted)]">
        The full reference: the <Link className="text-[color:var(--color-brand)] hover:underline" href="/merchant-portal/integration">integration guide</Link>.
      </p>
    </>
  );
}
