"use client";

// Appears at the bottom of a list page when one or more rows are selected.
// Modules pass `actions` — typical: Archive, Delete, Export, Edit (bulk).

import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface BulkAction {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  variant?: "default" | "secondary" | "danger";
  disabled?: boolean;
}

interface BulkBarProps {
  count: number;
  total: number;
  onClear: () => void;
  onSelectAll?: () => void;
  actions: BulkAction[];
}

export function BulkBar({ count, total, onClear, onSelectAll, actions }: BulkBarProps) {
  if (count === 0) return null;
  return (
    <div className="fixed inset-x-0 bottom-6 z-30 mx-auto flex w-fit max-w-[95%] items-center gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-2 shadow-lg">
      <Button variant="secondary" size="sm" className="h-8 w-8 p-0" onClick={onClear} aria-label="Clear selection">
        <X className="h-4 w-4" />
      </Button>
      <span className="text-sm font-medium">
        {count} of {total} selected
      </span>
      {onSelectAll && count < total && (
        <Button variant="secondary" size="sm" onClick={onSelectAll}>Select all {total}</Button>
      )}
      <div className="mx-1 h-6 w-px bg-[color:var(--color-border)]" />
      {actions.map((a, i) => {
        const Icon = a.icon;
        return (
          <Button
            key={`${a.label}-${i}`}
            size="sm"
            variant={a.variant === "danger" ? "danger" : a.variant === "secondary" ? "secondary" : "default"}
            disabled={a.disabled}
            onClick={a.onClick}
          >
            {Icon ? <Icon className="h-4 w-4" /> : null}
            {a.label}
          </Button>
        );
      })}
    </div>
  );
}
