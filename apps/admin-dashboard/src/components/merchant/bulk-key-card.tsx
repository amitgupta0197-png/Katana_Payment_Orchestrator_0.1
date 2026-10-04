"use client";

// Key + Salt for several bankers at once (staff: a merchant's page, Bankers tab; Super Admin and
// Admin only, lib/key-access). Pick one or more of the merchant's bankers and a mode; each picked banker gets its own, independent pair from the same
// per-banker route the single card uses (POST /api/merchants/{id}/checkout-key), one after another.
// One banker failing (a live pair before that banker's live mode is activated) does not stop the
// others. Every Salt is shown once, here, with a copy button per banker and for all of them.

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { usePortal } from "@/components/portal/portal-frame";

export interface BulkBanker { id: string; code: string; name: string }
type Result = { banker: BulkBanker } & ({ ok: true; key: string; salt: string; scheme: string } | { ok: false; error: string });

const MUTED = "text-[color:var(--color-text-muted)]";

export function BulkKeyCard({ bankers }: { bankers: BulkBanker[] }) {
  const qc = useQueryClient();
  const portal = usePortal();
  const [picked, setPicked] = useState<string[]>([]);
  const [live, setLive] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);

  const chosen = bankers.filter((b) => picked.includes(b.id));
  const all = picked.length === bankers.length;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const label = !chosen.length ? "Choose bankers"
    : chosen.length === 1 ? `${chosen[0].name} (${chosen[0].code})`
    : all ? `All ${bankers.length} bankers` : `${chosen.length} bankers`;

  async function run() {
    setRunning(true);
    const out: Result[] = [];
    for (const b of chosen) {
      try {
        const r = await fetch(`/api/merchants/${b.id}/checkout-key`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scheme: "HMAC_SHA256", livemode: live }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) out.push({ banker: b, ok: false, error: d.error ?? d.message ?? `HTTP ${r.status}` });
        else out.push({ banker: b, ok: true, key: d.creds.key, salt: d.creds.salt, scheme: d.creds.scheme });
      } catch (e) { out.push({ banker: b, ok: false, error: (e as Error).message }); }
      qc.invalidateQueries({ queryKey: ["merchant", b.id, "checkout-key"] });
    }
    setResults(out);
    setRunning(false);
  }

  function close() {
    setConfirm(false);
    setTimeout(() => { setResults(null); }, 200);
  }
  const copy = (v: string, what = "Copied") => { navigator.clipboard?.writeText(v); toast.success(what); };
  const done = results?.filter((r): r is Extract<Result, { ok: true }> => r.ok) ?? [];
  const allText = done.map((r) => `${r.banker.name} (${r.banker.code}) · ${live ? "live" : "test"}\nKey:  ${r.key}\nSalt: ${r.salt}`).join("\n\n");

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Generate for one or more bankers</CardTitle>
        <CardDescription>
          Pick the bankers and the mode. Each banker gets its own Key + Salt; the others are not touched. A live pair can only be made for a banker whose live mode is activated.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" className="min-w-[16rem] justify-between">
              <span className="truncate">{label}</span><ChevronDown className="h-4 w-4 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 min-w-[18rem] overflow-y-auto">
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setPicked(all ? [] : bankers.map((b) => b.id)); }}>
              <Tick on={all} /> {all ? "Clear all" : "Select all"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {bankers.map((b) => (
              <DropdownMenuItem key={b.id} onSelect={(e) => { e.preventDefault(); toggle(b.id); }}>
                <Tick on={picked.includes(b.id)} />
                <span className="truncate">{b.name}</span>
                <span className={`ml-auto pl-3 font-mono text-xs ${MUTED}`}>{b.code}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="inline-flex rounded-md border p-0.5 text-sm" role="radiogroup" aria-label="Mode">
          {([false, true] as const).map((l) => (
            <button key={String(l)} type="button" role="radio" aria-checked={live === l} onClick={() => setLive(l)}
              className={`rounded px-3 py-1 ${live === l ? "bg-[color:var(--color-surface-muted)] font-medium" : MUTED}`}>
              {l ? "Live" : "Test"}
            </button>
          ))}
        </div>

        <Button onClick={() => setConfirm(true)} disabled={!chosen.length}>
          <KeyRound className="h-4 w-4" /> Generate {chosen.length > 1 ? `${chosen.length} pairs` : "pair"}
        </Button>
      </CardContent>

      <Dialog open={confirm} onOpenChange={(o) => { if (!o && !running) close(); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Generate {live ? "live" : "test"} Key + Salt for {chosen.length === 1 ? "1 banker" : `${chosen.length} bankers`}</DialogTitle>
            <DialogDescription>
              Each banker gets its own pair. This replaces only the {live ? "live" : "test"} pair of the bankers below{live ? ", and anything still using one of their old live Keys stops working immediately" : ""}. Every Salt is shown once — store them securely.
            </DialogDescription>
          </DialogHeader>

          {!results ? (
            <ul className="space-y-1 text-sm">
              {chosen.map((b) => <li key={b.id}>{b.name} <span className={`font-mono text-xs ${MUTED}`}>{b.code}</span></li>)}
            </ul>
          ) : (
            <div className="space-y-3">
              {done.length > 0 && (
                <div className="rounded-md border border-[color:var(--color-success)]/30 bg-[color:var(--color-success-muted)] px-3 py-2 text-xs text-[color:var(--color-success)]">
                  {done.length} generated. Copy the Salts now — they won&rsquo;t be shown again.
                </div>
              )}
              {done.length > 1 && (
                <div className={`text-xs ${MUTED}`}>
                  To share orders between these bankers, turn on the banker switch under{" "}
                  <Link className="text-[color:var(--color-brand)] hover:underline" href={portal ? `${portal.base}/mid-switch` : `/mid-switch?banker=${encodeURIComponent(done[0].banker.code)}`}>MID switch</Link>: orders can then be signed with any of these Keys.
                </div>
              )}
              {results.map((r) => (
                <div key={r.banker.id} className="space-y-2 rounded-md border p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <b>{r.banker.name}</b> <span className={`font-mono text-xs ${MUTED}`}>{r.banker.code}</span>
                    <span className="ml-auto">{r.ok ? <Badge variant="success">{live ? "Live" : "Test"}</Badge> : <Badge variant="danger">Not generated</Badge>}</span>
                  </div>
                  {r.ok ? (
                    <>
                      <Row label="Key" value={r.key} onCopy={() => copy(r.key)} />
                      <Row label="Salt" value={r.salt} onCopy={() => copy(r.salt)} />
                    </>
                  ) : <div className="text-xs text-[color:var(--color-danger)]">{r.error}</div>}
                </div>
              ))}
            </div>
          )}

          <DialogFooter>
            {results ? (
              <>
                {done.length > 1 && <Button variant="secondary" onClick={() => copy(allText, "All copied")}><Copy className="h-4 w-4" /> Copy all</Button>}
                <Button onClick={close}>Done</Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={close} disabled={running}>Cancel</Button>
                <Button onClick={run} disabled={running}>{running ? "Generating…" : "Generate"}</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Tick({ on }: { on: boolean }) {
  return (
    <span className={`mr-2 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand)] text-white" : ""}`}>
      {on && <Check className="h-3 w-3" />}
    </span>
  );
}

function Row({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`w-10 text-xs ${MUTED}`}>{label}</span>
      <code className="flex-1 break-all rounded-md border bg-[color:var(--color-surface)] px-3 py-1.5 font-mono text-xs">{value}</code>
      <Button size="sm" variant="secondary" onClick={onCopy} aria-label={`Copy ${label}`}><Copy className="h-4 w-4" /></Button>
    </div>
  );
}
