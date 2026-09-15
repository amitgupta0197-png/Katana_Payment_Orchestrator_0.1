"use client";

// Test / Live switch for the dashboard header (admin shell and both portals).
//
// Saves the choice server-side (/api/me/mode sets the katana_mode cookie), then resets every
// cached query so lists reload in the new mode, and refreshes the server components so the
// test-mode banner appears or disappears with the page.

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const OPTIONS = [
  { livemode: false, label: "Test" },
  { livemode: true, label: "Live" },
] as const;

export function ModeSwitch({ initialLivemode }: { initialLivemode: boolean }) {
  const [livemode, setLivemode] = useState(initialLivemode);
  const [saving, setSaving] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const queryClient = useQueryClient();
  const router = useRouter();

  // A refresh re-renders the layout with the server's view of the cookie; follow it.
  useEffect(() => setLivemode(initialLivemode), [initialLivemode]);

  const busy = saving || refreshing;

  async function choose(next: boolean) {
    if (next === livemode || busy) return;
    const previous = livemode;
    setLivemode(next);
    setSaving(true);
    const res = await fetch("/api/me/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ livemode: next }),
    }).catch(() => null);
    setSaving(false);

    if (!res?.ok) {
      setLivemode(previous);
      toast.error("Couldn't switch mode", { description: "Check your connection and try again." });
      return;
    }
    startTransition(() => {
      void queryClient.resetQueries();
      router.refresh();
    });
    toast.success(next ? "Switched to live mode" : "Switched to test mode", {
      description: next ? "Showing real payments." : "Showing test data. Test orders never move real money.",
    });
  }

  return (
    <div
      role="radiogroup"
      aria-label="Data mode"
      className="inline-flex shrink-0 items-center rounded-full border bg-[color:var(--color-surface-muted)] p-0.5 text-xs font-semibold"
    >
      {OPTIONS.map((option) => {
        const active = livemode === option.livemode;
        return (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={busy}
            onClick={() => choose(option.livemode)}
            className={cn(
              "rounded-full px-2.5 py-1 transition-colors disabled:cursor-wait",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand)]",
              active
                ? option.livemode
                  ? "bg-[color:var(--color-surface)] text-[color:var(--color-text)] shadow-sm"
                  : "bg-[color:var(--color-testmode)] text-[color:var(--color-testmode-fg)] shadow-sm"
                : "text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
