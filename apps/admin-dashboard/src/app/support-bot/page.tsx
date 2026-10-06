"use client";

// The support assistant, as staff test it (lib/support-bot): pick a banker, or a merchant with all
// its bankers, and ask what they would ask. Each answer shows what the bot looked up, which model
// answered and what it cost, and can be rated with a note on what the right answer was. Merchants'
// own conversations from the portals and their Telegram groups are listed here too; the Telegram
// tab links groups and shows what the bot did in them (components/support-bot/telegram-panel).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Bot } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { AssistantChat, type Conversation } from "@/components/support-bot/assistant-chat";
import { TelegramPanel } from "@/components/support-bot/telegram-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Banker { id: string; code: string; name: string; stage: string }
interface Merchant { id: string; code: string; name: string }

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d as T;
}

export default function SupportBotPage() {
  const qc = useQueryClient();
  const [scope, setScope] = useState("");
  const list = useQuery({
    queryKey: ["support-bot", "list", scope],
    queryFn: () => getJson<{ configured: boolean; bankers: Banker[]; merchants: Merchant[]; conversations: Conversation[] }>(
      `/api/support-bot${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`),
    placeholderData: (prev) => prev,
  });
  const bankers = list.data?.bankers ?? [];
  const merchants = list.data?.merchants ?? [];
  const chosen = scope.startsWith("banker:")
    ? bankers.find((b) => `banker:${b.code}` === scope)
    : merchants.find((m) => `merchant:${m.id}` === scope);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <PageHeader title="Support assistant" icon={Bot}
        description="Ask what a merchant would ask, about their real setup, orders, payments, webhooks and payouts."
        actions={<Badge variant="warning">Staff test</Badge>} />

      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Ask as</span>
        <select value={scope} onChange={(e) => setScope(e.target.value)}
          className="h-9 min-w-[16rem] rounded-md border bg-[color:var(--color-surface)] px-2 text-sm">
          <option value="">Choose a banker or merchant…</option>
          {merchants.length > 0 && (
            <optgroup label="Merchants (all their bankers)">
              {merchants.map((m) => <option key={m.id} value={`merchant:${m.id}`}>{m.name} ({m.code})</option>)}
            </optgroup>
          )}
          <optgroup label="Bankers">
            {bankers.map((b) => <option key={b.id} value={`banker:${b.code}`}>{b.name} ({b.code}), {b.stage}</option>)}
          </optgroup>
        </select>
      </label>

      <Tabs defaultValue="test">
        <TabsList>
          <TabsTrigger value="test">Test</TabsTrigger>
          <TabsTrigger value="telegram">Telegram groups</TabsTrigger>
        </TabsList>
        <TabsContent value="test">
          <AssistantChat
            staff
            heightClass="h-[calc(100dvh-18rem)]"
            scope={scope || null}
            name={chosen?.name ?? null}
            configured={list.data?.configured ?? true}
            conversations={list.data?.conversations ?? []}
            onAnswered={() => qc.invalidateQueries({ queryKey: ["support-bot", "list"] })}
            onPickConversation={(c) => setScope(c.scope_key)}
          />
        </TabsContent>
        <TabsContent value="telegram">
          <TelegramPanel scope={scope || null} scopeName={chosen?.name ?? null} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
