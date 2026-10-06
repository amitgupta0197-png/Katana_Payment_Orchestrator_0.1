"use client";

// The banker's Starter Kit as chat messages (lib/starter-kit), for Katana staff on the banker's
// page and for its merchant in the merchant portal: pick WhatsApp, Telegram or plain text, then
// copy each message and paste it into the chat. Backed by /api/merchants/[id]/starter-kit.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Check, MessageSquareText, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type KitFormat = "whatsapp" | "telegram" | "plain";
interface Kit { merchant_code: string; issued_test_keys: boolean; format: KitFormat; parts: { title: string; text: string }[]; warnings: string[] }

const FORMATS: { value: KitFormat; label: string }[] = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "telegram", label: "Telegram" },
  { value: "plain", label: "Plain text" },
];
const MUTED = "text-[color:var(--color-text-muted)]";

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export function StarterKitCard({ merchantId }: { merchantId: string }) {
  const [format, setFormat] = useState<KitFormat>("whatsapp");
  const [length, setLength] = useState<"short" | "full">("short");
  const [copied, setCopied] = useState<number | "all" | null>(null);

  const q = useQuery({
    queryKey: ["merchant", merchantId, "starter-kit", format, length],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/starter-kit?format=${format}&length=${length}`, { cache: "no-store" });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
      return d as Kit;
    },
    // It holds a test Salt: keep it no longer than the page is open.
    gcTime: 0,
  });

  async function copy(which: number | "all") {
    const parts = q.data?.parts ?? [];
    const text = which === "all" ? parts.map((p) => p.text).join("\n\n") : parts[which]?.text ?? "";
    if (await copyText(text)) {
      setCopied(which);
      toast.success(which === "all" ? "Whole kit copied" : `Message ${which + 1} copied`);
      setTimeout(() => setCopied(null), 1500);
    } else toast.error("Couldn't copy. Select the text and copy it by hand.");
  }

  const parts = q.data?.parts ?? [];
  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base"><MessageSquareText className="h-4 w-4" /> Starter kit</CardTitle>
          <CardDescription>
            Short: one message with the test Key + Salt, where to send orders and a link to the full guide.
            Full guide: step-by-step messages with examples. The live Salt is never included.
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Length" className="inline-flex rounded-md border p-0.5">
            {([["short", "Short"], ["full", "Full guide"]] as const).map(([v, label]) => (
              <button key={v} role="radio" aria-checked={length === v} onClick={() => setLength(v)}
                className={`rounded px-2.5 py-1 text-xs font-medium ${length === v
                  ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]" : MUTED}`}>
                {label}
              </button>
            ))}
          </div>
          <div role="radiogroup" aria-label="Messenger" className="inline-flex rounded-md border p-0.5">
            {FORMATS.map((f) => (
              <button key={f.value} role="radio" aria-checked={format === f.value} onClick={() => setFormat(f.value)}
                className={`rounded px-2.5 py-1 text-xs font-medium ${format === f.value
                  ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]" : MUTED}`}>
                {f.label}
              </button>
            ))}
          </div>
          <Button size="sm" onClick={() => copy("all")} disabled={!parts.length}>
            {copied === "all" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} Copy all
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading && <p className={`text-sm ${MUTED}`}>Writing the kit…</p>}
        {q.isError && <p className="text-sm text-[color:var(--color-danger)]">Couldn&rsquo;t build the kit: {(q.error as Error).message}</p>}
        {q.data?.issued_test_keys && (
          <p className="rounded-md bg-[color:var(--color-brand-muted)] px-3 py-2 text-xs">
            This banker had no test keys, so a test Key + Salt were just made for the kit.
          </p>
        )}
        {!!q.data?.warnings.length && (
          <div className="rounded-md border border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning-muted)] px-3 py-2 text-xs">
            <div className="mb-1 flex items-center gap-1.5 font-semibold text-[color:var(--color-warning)]"><TriangleAlert className="h-3.5 w-3.5" /> Before you send it</div>
            <ul className="list-disc space-y-0.5 pl-5">{q.data.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        )}
        {format === "telegram" && parts.length > 0 && (
          <p className={`text-xs ${MUTED}`}>Telegram takes about 4,000 characters per message, so send them one at a time.</p>
        )}
        {parts.map((p, i) => (
          <div key={`${format}-${i}`} className="rounded-md border">
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
              <span className="text-sm font-medium">Message {i + 1} of {parts.length}: {p.title}</span>
              <Button size="sm" variant="secondary" onClick={() => copy(i)}>
                {copied === i ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} Copy
              </Button>
            </div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed">{p.text}</pre>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
