"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Handshake } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PartnerPanel } from "@/components/partner/partner-panel";

export default function View({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["partner", id],
    queryFn: async () => { const r = await fetch(`/api/partners/${id}`); return r.ok ? r.json() : null; },
  });
  return (
    <div>
      <Link href="/partners" className="mb-3 inline-flex items-center gap-1 text-sm text-[color:var(--color-text-muted)] hover:underline">
        <ArrowLeft className="h-4 w-4" /> Partners
      </Link>
      <PageHeader title={q.data?.partner?.name ?? "Partner"} icon={Handshake}
        description="A payment aggregator whose own merchants take payments through Katana." />
      <PartnerPanel partnerId={id} />
    </div>
  );
}
