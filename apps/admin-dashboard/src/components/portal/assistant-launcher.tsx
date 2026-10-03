"use client";

// The floating "Ask Katana" button on every page of a portal, opening the support assistant in a panel
// beside the page (lib/support-bot). The same chat and conversations as the Assistant page: the
// server decides whose records it reads from the login. Hidden on the Assistant page itself, and only
// shown while the assistant is open to portals (PortalFrame's `assistant`).

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Maximize2, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PortalAssistant } from "@/components/support-bot/portal-assistant";

export function AssistantLauncher({ base }: { base: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const page = `${base}/assistant`;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  // Leaving for the full page closes the panel, so the two are never open together.
  useEffect(() => { if (pathname.startsWith(page)) setOpen(false); }, [pathname, page]);

  if (pathname.startsWith(page)) return null;

  return (
    <>
      {!open && (
        <button type="button" onClick={() => setOpen(true)} aria-label="Ask the Katana assistant"
          className={cn(
            "fixed right-4 z-40 flex items-center gap-2 rounded-full bg-[color:var(--color-brand)] px-4 py-3 text-sm font-semibold text-white shadow-lg",
            "transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
            // Above the phone tab bar (h-16 + safe area); bottom corner on wider screens.
            "bottom-[calc(5rem+env(safe-area-inset-bottom))] md:bottom-6 md:right-6",
          )}>
          <Sparkles className="h-5 w-5" />
          <span className="hidden sm:inline">Ask Katana</span>
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end md:inset-auto md:bottom-6 md:right-6 md:top-auto" role="dialog" aria-label="Katana assistant">
          <button aria-label="Close the assistant" className="absolute inset-0 bg-black/30 md:hidden" onClick={() => setOpen(false)} />
          <div className="relative flex h-full w-full flex-col overflow-hidden bg-[color:var(--color-surface)] shadow-2xl md:h-[min(42rem,calc(100dvh-3rem))] md:w-[26rem] md:rounded-2xl md:border">
            <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-[color:var(--color-brand)]" /> Katana assistant</div>
              <div className="flex items-center gap-1">
                <Link href={page} aria-label="Open the full assistant page" className="rounded-md p-1.5 text-[color:var(--color-text-muted)] hover:bg-[color:var(--color-surface-muted)]"><Maximize2 className="h-4 w-4" /></Link>
                <button type="button" onClick={() => setOpen(false)} aria-label="Close the assistant" className="rounded-md p-1.5 text-[color:var(--color-text-muted)] hover:bg-[color:var(--color-surface-muted)]"><X className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <Suspense><PortalAssistant compact /></Suspense>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
