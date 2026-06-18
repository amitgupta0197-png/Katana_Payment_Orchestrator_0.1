"use client";

// Per-entity activity feed. Polls /api/activity?resource_type=...&resource_id=...
// Drops into any DetailShell tab — or any Drawer for inline timeline.

import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import { EmptyState } from "./empty-state";

interface Event {
  id: string;
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string;
  notes: string;
  before_value: Record<string, unknown>;
  after_value: Record<string, unknown>;
  at: string;
}

interface Props {
  resourceType: string;
  resourceId: string;
  limit?: number;
}

function diffKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])) out.push(k);
  }
  return out;
}

export function ActivityFeed({ resourceType, resourceId, limit = 50 }: Props) {
  const q = useQuery({
    queryKey: ["activity", resourceType, resourceId, limit],
    queryFn: async () =>
      (await fetch(`/api/activity?resource_type=${encodeURIComponent(resourceType)}&resource_id=${encodeURIComponent(resourceId)}&limit=${limit}`).then((r) => r.json())) as { events: Event[] },
    refetchInterval: 15_000,
  });

  if (q.isLoading) {
    return <div className="rounded-md border bg-[color:var(--color-surface)] p-6 text-center text-sm text-[color:var(--color-text-muted)]">Loading activity…</div>;
  }
  const events = q.data?.events ?? [];
  if (events.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No activity yet"
        description="Once an action is taken on this record, it'll appear here. Audit rows are tamper-evident (WORM)."
      />
    );
  }

  return (
    <ol className="relative ml-3 border-l border-[color:var(--color-border)] pl-4">
      {events.map((ev) => {
        const changed = diffKeys(ev.before_value, ev.after_value);
        return (
          <li key={ev.id} className="relative pb-5">
            <span className="absolute -left-[1.4rem] top-1 flex h-3 w-3 items-center justify-center rounded-full border-2 border-[color:var(--color-brand)] bg-[color:var(--color-surface)]" />
            <div className="flex items-center justify-between gap-2 text-sm">
              <div className="min-w-0">
                <span className="font-medium">{ev.actor}</span>{" "}
                <Badge variant="brand">{ev.action}</Badge>
                {ev.notes && <span className="ml-2 text-[color:var(--color-text-muted)]">— {ev.notes}</span>}
              </div>
              <time className="shrink-0 text-xs text-[color:var(--color-text-muted)]">{formatDateTime(ev.at)}</time>
            </div>
            {changed.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-[color:var(--color-text-muted)]">
                {changed.slice(0, 4).map((k) => (
                  <span key={k} className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5">
                    <code className="font-mono">{k}</code>
                    <ArrowRight className="h-3 w-3" />
                    <code className="font-mono">{String(ev.after_value?.[k] ?? "")}</code>
                  </span>
                ))}
                {changed.length > 4 && <span>+{changed.length - 4} more</span>}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
