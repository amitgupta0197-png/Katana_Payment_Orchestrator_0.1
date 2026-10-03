"use client";

// The support assistant in the merchant portal and the banker portal (lib/support-bot). The
// server decides whose data it reads from the login; this page only shows the chat.

import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { AssistantChat, type Conversation } from "@/components/support-bot/assistant-chat";

interface PortalList {
  configured: boolean; name: string | null; accounts: { code: string; name: string }[];
  conversations: Conversation[]; questions_left_today: number;
}

/** `compact`: inside the floating panel (components/portal/assistant-launcher), no page header. */
export function PortalAssistant({ compact = false }: { compact?: boolean } = {}) {
  const qc = useQueryClient();
  // Handed over by another page: Home's actions and the "customer says they paid" button.
  const params = useSearchParams();
  const ask = (params.get("ask") ?? "").slice(0, 500);
  const list = useQuery({
    queryKey: ["support-bot", "list", "portal"],
    queryFn: async () => {
      const r = await fetch("/api/support-bot", { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(d.error ?? `HTTP ${r.status}`), { code: d.code });
      return d as PortalList;
    },
    retry: false,
  });

  if (list.error) {
    if (compact) return <p className="p-4 text-sm text-[color:var(--color-text-muted)]">{list.error.message}</p>;
    return (
      <>
        <PageHeader title="Assistant" icon={Sparkles} description="Help with payments, webhooks and payouts." />
        <p className="text-sm text-[color:var(--color-text-muted)]">{list.error.message}</p>
      </>
    );
  }

  if (compact) {
    return (
      <AssistantChat
        staff={false}
        name={list.data?.name ?? null}
        configured={list.data?.configured ?? true}
        conversations={list.data?.conversations ?? []}
        onAnswered={() => qc.invalidateQueries({ queryKey: ["support-bot", "list", "portal"] })}
        heightClass="h-full"
        compact
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Assistant" icon={Sparkles}
        description="Ask about a payment, an error, a webhook or a payout. It checks your own records before it answers." />
      <AssistantChat
        staff={false}
        name={list.data?.name ?? null}
        configured={list.data?.configured ?? true}
        conversations={list.data?.conversations ?? []}
        onAnswered={() => qc.invalidateQueries({ queryKey: ["support-bot", "list", "portal"] })}
        initialText={ask}
        nudgeScreenshot={params.get("screenshot") === "1"}
      />
    </div>
  );
}
