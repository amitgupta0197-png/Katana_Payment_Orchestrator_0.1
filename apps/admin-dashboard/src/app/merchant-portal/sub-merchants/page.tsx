"use client";

// The partner's own view of its merchants (lib/partner): shown in the menu only to a merchant that is a partner.

import { useQuery } from "@tanstack/react-query";
import { Handshake } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PartnerPanel } from "@/components/partner/partner-panel";

export default function SubMerchantsPage() {
  const q = useQuery({ queryKey: ["partner", "me"], queryFn: async () => { const r = await fetch("/api/partners/me"); return r.ok ? r.json() : null; } });
  return (
    <div>
      <PageHeader title="Sub-merchants" icon={Handshake}
        description="Your merchants: add them, see whether Katana has approved them, and follow their payments." />
      {q.isLoading ? null : q.data ? <PartnerPanel partnerId="me" /> : (
        <p className="text-sm text-[color:var(--color-text-muted)]">This account is not set up as a partner. Ask Katana support if your merchants should take payments through you.</p>
      )}
    </div>
  );
}
