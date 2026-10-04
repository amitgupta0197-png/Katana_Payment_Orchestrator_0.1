"use client";

// Small pieces shared by the MDM screens (app/mdm). Staff only.

import { Building2, Landmark, Network, Store, Waypoints, type LucideIcon } from "lucide-react";
import type { MasterType } from "@/lib/mdm";

export async function readJson<T>(r: Response): Promise<T> {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(d.error ?? "HTTP " + r.status) as Error & { body?: any };
    e.body = d;
    throw e;
  }
  return d as T;
}

export const TYPE_ICON: Record<MasterType, LucideIcon> = {
  BANK: Landmark, TSP: Network, BANKER: Building2, MERCHANT: Store, CHANNEL: Waypoints,
};

export const slug = (t: MasterType) => t.toLowerCase();

export const muted = "text-[color:var(--color-text-muted)]";

export function fmtTime(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " IST";
}

/** A stored value as text for tables and read-only fields. */
export function fmtValue(v: unknown, opts: { sensitive?: boolean; type?: string } = {}): string {
  if (opts.sensitive) return v ? "Set (hidden)" : "Not set";
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (opts.type === "timestamp") return fmtTime(String(v));
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export const selectCls = "flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]";
