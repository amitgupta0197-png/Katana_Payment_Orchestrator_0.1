"use client";

// Relationship Map: the record in the middle, each kind of related record as a column of nodes
// joined to it. Plain HTML so it wraps on a phone. Staff only.

import Link from "next/link";
import { KeyRound } from "lucide-react";
import type { MasterType } from "@/lib/mdm";
import type { Relationship } from "@/lib/mdm-store";
import { TYPE_ICON, muted } from "./shared";

export function RelationshipMap({ type, title, relationships }: { type: MasterType; title: string; relationships: Relationship[] }) {
  const Center = TYPE_ICON[type];
  if (!relationships.length) return <p className={`text-sm ${muted}`}>This master type has no links to other master records.</p>;
  return (
    <div className="space-y-4">
      <div className="flex justify-center">
        <div className="inline-flex items-center gap-2 rounded-full border-2 border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)] px-4 py-2 text-sm font-semibold">
          <Center className="h-4 w-4" /> {title}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {relationships.map((r) => {
          const Icon = r.target === "MID" ? KeyRound : TYPE_ICON[r.target];
          return (
            <div key={r.key} className="relative rounded-xl border p-3">
              <span aria-hidden className="absolute -top-4 left-1/2 hidden h-4 w-px bg-[color:var(--color-border-strong)] sm:block" />
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-sm font-medium"><Icon className="h-4 w-4" /> {r.label}</span>
                <span className={`text-xs tabular-nums ${muted}`}>{r.items.length}</span>
              </div>
              {r.items.length ? (
                <ul className="space-y-1.5">
                  {r.items.slice(0, 25).map((i) => (
                    <li key={i.id} className="rounded-lg bg-[color:var(--color-surface-muted)] px-2 py-1.5 text-sm">
                      {i.href ? <Link href={i.href} className="font-medium hover:underline break-words">{i.label}</Link> : <span className="font-mono text-xs">{i.label}</span>}
                      {i.sub && <div className={`text-xs ${muted}`}>{i.sub}</div>}
                    </li>
                  ))}
                  {r.items.length > 25 && <li className={`text-xs ${muted}`}>and {r.items.length - 25} more</li>}
                </ul>
              ) : <p className={`text-xs ${muted}`}>None linked.</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
