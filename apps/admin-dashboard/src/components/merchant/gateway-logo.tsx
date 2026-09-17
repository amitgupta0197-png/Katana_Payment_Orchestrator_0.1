"use client";

// A payment gateway's logo on a white tile (the marks are made for light backgrounds), or its
// initials in the brand colour when Katana has no logo file for it.

import { gatewayDef } from "@/lib/pg-catalog";
import { cn } from "@/lib/utils";

export function shortGatewayName(name: string): string {
  return name.replace(/ Payment Gateway$| Payments$/, "");
}

export function GatewayLogo({ id, size = 28, className }: { id: string; size?: number; className?: string }) {
  const g = gatewayDef(id);
  const name = g?.name ?? id;
  const box = { width: size, height: size };
  if (g?.logo) {
    return (
      <span className={cn("inline-grid shrink-0 place-items-center overflow-hidden rounded-md bg-white", className)} style={box}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={g.logo} alt="" width={Math.round(size * 0.72)} height={Math.round(size * 0.72)} className="object-contain" />
        <span className="sr-only">{name}</span>
      </span>
    );
  }
  const initials = shortGatewayName(name).replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();
  return (
    <span
      className={cn("inline-grid shrink-0 place-items-center rounded-md font-semibold text-white", className)}
      style={{ ...box, background: g?.color ?? "var(--color-brand)", fontSize: Math.round(size * 0.38) }}
      aria-label={name}
    >
      {initials}
    </span>
  );
}
