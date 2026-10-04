"use client";

// Shared bits for the workflow screens (/journeys, /journeys/{id}, /workflow-templates).

import { Badge } from "@/components/ui/badge";
import { Check, Circle, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SlaStatus, StepType } from "@/lib/workflow";

export async function readJson<T>(r: Response): Promise<T> {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error ?? "HTTP " + r.status), { code: d.code, problems: d.problems });
  return d as T;
}

export const ACTOR_LABEL: Record<string, string> = {
  TSP: "TSPs", BANKER: "Bankers", MERCHANT: "Merchants", MID: "MIDs", BANKER_SUSPENSION: "Banker suspensions",
};

export const STEP_TYPE_LABEL: Record<StepType, string> = {
  DOCUMENT_UPLOAD: "Documents", MANUAL_REVIEW: "Review by a person", SYSTEM_CHECK: "Checked by the system",
  MAKER_CHECKER: "Maker-Checker", NOTIFICATION: "Notification",
};

export const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: "Super Admin", ADMIN: "Admin", OPERATOR: "Operator", COMPLIANCE: "Compliance", RISK: "Risk", FINANCE: "Finance", SUPPORT: "Support",
};

export const selectCls = "flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]";

export function SlaBadge({ sla }: { sla: SlaStatus | null }) {
  if (!sla) return <span className="text-xs text-[color:var(--color-text-subtle)]">—</span>;
  const v = sla === "BREACHED" ? "danger" : sla === "AT_RISK" ? "warning" : "success";
  const label = sla === "BREACHED" ? "Breached" : sla === "AT_RISK" ? "At risk" : "On track";
  return <Badge variant={v}>{label}</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  const v = status === "COMPLETED" ? "success" : status === "REJECTED" ? "danger" : status === "PAUSED" ? "warning" : "info";
  const label = status === "IN_PROGRESS" ? "In progress" : status.charAt(0) + status.slice(1).toLowerCase();
  return <Badge variant={v}>{label}</Badge>;
}

export type StepStateName = "PENDING" | "ACTIVE" | "DONE" | "FAILED" | "SKIPPED";

export function StepIcon({ state, className }: { state: StepStateName; className?: string }) {
  if (state === "DONE") return <Check className={cn("h-4 w-4 text-[color:var(--color-success)]", className)} aria-label="Done" />;
  if (state === "FAILED") return <X className={cn("h-4 w-4 text-[color:var(--color-danger)]", className)} aria-label="Failed" />;
  if (state === "ACTIVE") return <Loader2 className={cn("h-4 w-4 text-[color:var(--color-brand)] motion-safe:animate-spin [animation-duration:2.5s]", className)} aria-label="Current" />;
  return <Circle className={cn("h-4 w-4 text-[color:var(--color-text-subtle)]", className)} aria-label="Not started" />;
}

/** Horizontal stepper in the style of the onboarding stepper on the TSP and banker pages. */
export function WorkflowStepper({ steps, stopped }: { steps: { step_id: string; name: string; state: StepStateName }[]; stopped?: boolean }) {
  return (
    <ol className="grid gap-1" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} aria-label="Workflow steps">
      {steps.map((s) => {
        const done = s.state === "DONE";
        const current = s.state === "ACTIVE";
        const failed = s.state === "FAILED";
        return (
          <li key={s.step_id} className="min-w-0" aria-current={current ? "step" : undefined}>
            <div className={cn("h-1.5 rounded-full", current && "animate-pulse motion-reduce:animate-none")}
              style={{ background: done ? "var(--color-success)" : current ? "var(--color-brand)" : failed ? "var(--color-danger)" : stopped ? "var(--color-danger-muted)" : "var(--color-border)" }} />
            <div className={cn("mt-1.5 hidden items-center gap-1 truncate text-[11px] sm:flex",
              done ? "text-[color:var(--color-text-muted)]" : current ? "font-medium text-[color:var(--color-text)]" : "text-[color:var(--color-text-subtle)]")}>
              {done && <Check className="h-3 w-3 shrink-0 text-[color:var(--color-success)]" />}
              <span className="truncate" title={s.name}>{s.name}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function fmtHours(h: number | null | undefined): string {
  if (!h) return "No timeout";
  return h >= 48 && h % 24 === 0 ? `${h / 24} days` : `${h} h`;
}
