"use client";

// Kebab menu on every row of a world-class list. Edit / Duplicate / Archive /
// Delete / View activity / Open in new tab — modules pick which actions apply.

import * as React from "react";
import { MoreHorizontal, ExternalLink, Activity, Copy, Pencil, Archive, Trash2 } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

export interface RowAction {
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  variant?: "default" | "danger";
  shortcut?: string;
  disabled?: boolean;
  separatorBefore?: boolean;
}

interface RowActionsProps {
  actions: RowAction[];
  openHref?: string;
  onOpenActivity?: () => void;
  label?: string;
}

// Built-in defaults — modules pass a typed handler set; we render the menu.
export function RowActions({ actions, openHref, onOpenActivity, label = "Actions" }: RowActionsProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={(e) => e.stopPropagation()}
          aria-label={label}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {openHref && (
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); window.open(openHref, "_blank", "noopener,noreferrer"); }}>
            <ExternalLink className="h-4 w-4" /> Open in new tab
          </DropdownMenuItem>
        )}
        {onOpenActivity && (
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); onOpenActivity(); }}>
            <Activity className="h-4 w-4" /> View activity
          </DropdownMenuItem>
        )}
        {(openHref || onOpenActivity) && actions.length > 0 && <DropdownMenuSeparator />}
        {actions.map((a, i) => {
          const Icon = a.icon;
          return (
            <React.Fragment key={`${a.label}-${i}`}>
              {a.separatorBefore && <DropdownMenuSeparator />}
              <DropdownMenuItem
                disabled={a.disabled}
                variant={a.variant}
                onSelect={(e) => { e.preventDefault(); if (!a.disabled) a.onClick(); }}
              >
                {Icon ? <Icon className="h-4 w-4" /> : null}
                {a.label}
                {a.shortcut && <span className="ml-auto text-xs tracking-widest text-[color:var(--color-text-muted)]">{a.shortcut}</span>}
              </DropdownMenuItem>
            </React.Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Pre-baked action helpers — convenient for the common verbs.
export const ACT = {
  edit: (onClick: () => void): RowAction => ({ label: "Edit", icon: Pencil, onClick, shortcut: "E" }),
  duplicate: (onClick: () => void): RowAction => ({ label: "Duplicate", icon: Copy, onClick, shortcut: "D" }),
  archive: (onClick: () => void): RowAction => ({ label: "Archive", icon: Archive, onClick, shortcut: "A" }),
  remove: (onClick: () => void): RowAction => ({ label: "Delete", icon: Trash2, onClick, variant: "danger", shortcut: "⌫", separatorBefore: true }),
};
