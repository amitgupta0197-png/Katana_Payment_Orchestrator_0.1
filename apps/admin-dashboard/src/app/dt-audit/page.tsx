"use client";

// DT Audit Trail (BRD §9). Every DT mutation — rate changes, purchase transitions,
// refill verification, settlements — lands in dt_audit_logs via auditDt(). This is the
// investigator's view: who did what to which entity, with the before/after payload.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataView } from "@/components/world-class/data-view";
import { Badge } from "@/components/ui/badge";
import type { Column } from "@/components/ui/data-table";
import { formatDateTime } from "@/lib/utils";

interface AuditEntry {
  id: string; actor: string; action: string; entity: string; entity_id: string;
  before: unknown; after: unknown; correlation_id: string; created_at: string;
}

// Action → badge colour. Anything unmapped falls back to neutral rather than
// guessing, so a new action type never renders as a misleading "success".
const ACTION_VARIANT: Record<string, "default" | "info" | "warning" | "success" | "danger"> = {
  RATE_SET: "info",
  PURCHASE_APPROVED: "success",
  PURCHASE_REJECTED: "danger",
  PURCHASE_ACTIVE: "success",
  REFILL_VERIFIED: "success",
  REFILL_CANCELLED: "danger",
  SETTLEMENT_RECORDED: "info",
};

function variantFor(action: string) {
  if (ACTION_VARIANT[action]) return ACTION_VARIANT[action];
  if (/CANCEL|REJECT|FAIL/i.test(action)) return "danger";
  if (/VERIFI|APPROV|CONFIRM|ACTIVE/i.test(action)) return "success";
  return "default";
}

// Render a before/after payload compactly. Long JSON is clipped rather than
// wrapped so one wide row can't push the table off-screen.
function Payload({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-[color:var(--color-text-subtle)]">—</span>;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (
    <code className="block max-w-[28rem] truncate font-mono text-[11px] text-[color:var(--color-text-muted)]" title={text}>
      {text}
    </code>
  );
}

export default function DtAuditPage() {
  const [entity, setEntity] = useState<string>("");

  const q = useQuery({
    queryKey: ["dt-audit", entity],
    queryFn: async () => {
      const qs = entity ? `?entity=${encodeURIComponent(entity)}` : "";
      const r = await fetch(`/api/v1/dt/audit${qs}`);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as { entries: AuditEntry[]; entities: string[]; actions: string[] };
    },
  });

  const cols: Column<AuditEntry>[] = [
    { key: "created_at", header: "When", render: (r) => formatDateTime(r.created_at) },
    { key: "actor", header: "Actor", render: (r) => <span className="font-medium">{r.actor || "system"}</span> },
    { key: "action", header: "Action", render: (r) => <Badge variant={variantFor(r.action)}>{r.action}</Badge> },
    {
      key: "entity",
      header: "Entity",
      render: (r) => (
        <span className="whitespace-nowrap">
          {r.entity}
          {r.entity_id ? <span className="text-[color:var(--color-text-subtle)]"> · {r.entity_id.slice(0, 8)}</span> : null}
        </span>
      ),
    },
    {
      key: "change",
      header: "Before → after",
      render: (r) => (
        <div className="flex items-center gap-2">
          <Payload value={r.before} />
          <ChevronRight className="h-3 w-3 shrink-0 text-[color:var(--color-text-subtle)]" aria-hidden />
          <Payload value={r.after} />
        </div>
      ),
    },
  ];

  const entities = q.data?.entities ?? [];

  return (
    <>
      <PageHeader
        title="DT Audit Trail"
        description="Every DT mutation with actor, entity and the before/after payload (BRD §9, §18)."
        icon={ScrollText}
      />

      {entities.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-widest text-[color:var(--color-text-subtle)]">Entity</span>
          <button
            type="button"
            onClick={() => setEntity("")}
            className={`rounded-full px-3 py-1 text-xs ${entity === "" ? "bg-[color:var(--color-brand)] text-[color:var(--color-brand-fg)]" : "bg-[color:var(--color-surface-muted)] text-[color:var(--color-text-muted)]"}`}
          >
            All
          </button>
          {entities.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => setEntity(e)}
              className={`rounded-full px-3 py-1 text-xs ${entity === e ? "bg-[color:var(--color-brand)] text-[color:var(--color-brand-fg)]" : "bg-[color:var(--color-surface-muted)] text-[color:var(--color-text-muted)]"}`}
            >
              {e}
            </button>
          ))}
        </div>
      )}

      <DataView
        rows={q.data?.entries ?? []}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search actor, action, entity…", fields: ["actor", "action", "entity", "entity_id"] }}
        refresh={() => q.refetch()}
        emptyTitle="No audit entries"
        emptyDescription="DT rate changes, purchase transitions and refill verifications appear here as they happen."
      />
    </>
  );
}
