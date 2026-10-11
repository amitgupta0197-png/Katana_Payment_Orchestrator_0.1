"use client";

// "Pair the banker's phone": a one-time QR + code that sets up the Katana Agent for this banker
// (lib/agent-pair, POST /api/merchants/{id}/agent-pair). Scanned with the phone's camera it opens
// the agent (v3.23+), which pairs itself: banker code, server, payment app, BharatPe key.
// Staff (Super Admin, Admin). Used on the wizard's last screen and the banker's "Pays UPI ID" tab.

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface PairCode { code: string; shown: string; link: string; expires_at: string }

export function AgentPairPanel({ merchantId, compact = false }: { merchantId: string; compact?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const make = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/agent-pair`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d as PairCode;
    },
  });
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const p = make.data;
  const left = p ? Math.max(0, Math.floor((new Date(p.expires_at).getTime() - now) / 1000)) : 0;
  const expired = !!p && left === 0;

  return (
    <div className="space-y-3 text-sm">
      {!p || expired ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => make.mutate()} disabled={make.isPending}>
            <Smartphone className="h-4 w-4" /> {make.isPending ? "Making a code…" : expired ? "Make a new pairing code" : "Show pairing QR"}
          </Button>
          {make.isError && <span className="text-[color:var(--color-danger)]">{(make.error as Error).message}</span>}
          {!compact && <span className="text-xs text-[color:var(--color-text-muted)]">Works once, for 15 minutes. Making a new one cancels the old.</span>}
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-5">
          <div className="rounded-xl bg-white p-3"><QRCodeSVG value={p.link} size={compact ? 140 : 168} level="M" /></div>
          <div className="min-w-[200px] flex-1 space-y-2">
            <ol className="list-decimal space-y-1 pl-4">
              <li>Install the <a href="/katana-agent.apk" className="font-medium text-[color:var(--color-brand)] hover:underline">Katana Agent</a> (v3.23 or newer) on the banker&apos;s phone.</li>
              <li>Scan this QR with the phone&apos;s camera — the agent opens and pairs itself.</li>
              <li>Or in the agent, type the code under <b>Pair with Katana</b>:</li>
            </ol>
            <div className="inline-block rounded-lg bg-[color:var(--color-surface-muted)] px-3 py-1.5 font-mono text-xl font-semibold tracking-[0.2em]">{p.shown}</div>
            <div className="text-xs text-[color:var(--color-text-muted)]">
              Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} · works once. It sets the banker code, the payment app to read and, for BharatPe, the MID key — nothing to type or paste.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentPairCard({ merchantId }: { merchantId: string }) {
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Smartphone className="h-4 w-4" /> Pair the banker&apos;s phone</CardTitle>
        <CardDescription>Set up the capture phone by scanning a QR — no banker code to type, no BharatPe key to paste.</CardDescription>
      </CardHeader>
      <CardContent><AgentPairPanel merchantId={merchantId} /></CardContent>
    </Card>
  );
}
