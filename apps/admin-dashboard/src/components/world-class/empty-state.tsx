"use client";

// Designed empty state (vs the "No records." default). Use on every list page
// so first-time users get a clear next action instead of a blank table.

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void; icon?: React.ComponentType<{ className?: string }> };
  secondaryAction?: { label: string; href?: string; onClick?: () => void };
  className?: string;
}

export function EmptyState({
  icon: Icon = Inbox, title, description, action, secondaryAction, className,
}: EmptyStateProps) {
  const ActionIcon = action?.icon;
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-lg border border-dashed bg-[color:var(--color-surface)] py-12 px-6 text-center", className)}>
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]">
        <Icon className="h-6 w-6" aria-hidden />
      </span>
      <h3 className="mt-3 text-base font-semibold tracking-tight">{title}</h3>
      {description && (
        <p className="mt-1 max-w-md text-sm text-[color:var(--color-text-muted)]">{description}</p>
      )}
      {(action || secondaryAction) && (
        <div className="mt-4 flex items-center gap-2">
          {action && (
            <Button onClick={action.onClick}>
              {ActionIcon ? <ActionIcon className="h-4 w-4" /> : null}
              {action.label}
            </Button>
          )}
          {secondaryAction && (
            secondaryAction.href ? (
              <Button asChild variant="secondary"><a href={secondaryAction.href}>{secondaryAction.label}</a></Button>
            ) : (
              <Button variant="secondary" onClick={secondaryAction.onClick}>{secondaryAction.label}</Button>
            )
          )}
        </div>
      )}
    </div>
  );
}
