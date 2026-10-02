"use client";

// "Send test event" (lib/webhook-test): a sample of one event, sent to the banker's saved
// callback URL in the banker's own webhook version. It belongs to no order and changes none.
// Used on the Webhooks page and on an order's timeline.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Send, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const EVENTS = ["payment.success", "payment.failed", "payment.expired"] as const;

interface Result { ok: boolean; error?: string; result?: { ok: boolean; http_status: number | null; latency_ms: number; error: string | null } }

export function TestEventButton({ merchantCode, disabled }: { merchantCode: string; disabled?: boolean }) {
  const qc = useQueryClient();
  const test = useMutation({
    mutationFn: async (event: string) => {
      const r = await fetch("/api/portal/webhooks/test", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ merchant_code: merchantCode, event }),
      });
      const d = (await r.json().catch(() => ({}))) as Result;
      // A sample the receiving server refused is a result, not a failure to send.
      if (!r.ok && !d.result && !d.error) throw new Error("HTTP " + r.status);
      return d;
    },
    onSuccess: (d) => {
      if (d.result?.ok) toast.success(`Your server answered HTTP ${d.result.http_status} in ${d.result.latency_ms} ms`);
      else toast.error("Test event not accepted", { description: d.result?.error ?? d.error ?? "no answer" });
      qc.invalidateQueries({ queryKey: ["portal:webhook-tests", merchantCode] });
    },
    onError: (e: Error) => toast.error("Test event not sent", { description: e.message }),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="secondary" disabled={disabled || test.isPending}><Send className="h-3.5 w-3.5" /> Send test event <ChevronDown className="h-3.5 w-3.5" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {EVENTS.map((e) => (
          <DropdownMenuItem key={e} onSelect={() => test.mutate(e)}><span className="font-mono text-xs">{e}</span></DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
