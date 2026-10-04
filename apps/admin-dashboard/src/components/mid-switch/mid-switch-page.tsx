"use client";

// The MID switch page: pick a banker (a merchant has several; a banker is just itself; staff any
// banker by code), then its switch (components/mid-switch/mid-switch-panel).

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightLeft } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { MidSwitchPanel } from "@/components/mid-switch/mid-switch-panel";
import { BankerSwitchCard } from "@/components/mid-switch/banker-switch-card";
import { usePortal } from "@/components/portal/portal-frame";

interface Summary { banker: string; name: string; kinds: Record<"GATEWAY" | "UPI", { total: number; active: number }> }

export function MidSwitchPage({ description }: { description: string }) {
  const q = useQuery({
    queryKey: ["mid-switch-bankers"],
    queryFn: async () => (await fetch("/api/mid-switch").then((r) => r.json())) as { bankers: Summary[]; staff: boolean },
  });
  const [banker, setBanker] = useState("");
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("banker");
    if (fromUrl) setBanker(fromUrl);
  }, []);
  useEffect(() => { if (!banker && q.data?.bankers.length) setBanker(q.data.bankers[0].banker); }, [banker, q.data]);
  const list = q.data?.bankers ?? [];
  // The banker switch is the merchant's: shown on the merchant portal, and to staff for the chosen
  // banker's merchant. A banker login is not shown its merchant's other bankers.
  const portal = usePortal();

  /** "Open": a banker code (any case) or a name; reopening the one shown reloads it. */
  function open(e: React.FormEvent) {
    e.preventDefault();
    const t = typed.trim();
    if (!t) return;
    const lc = t.toLowerCase();
    const hit = list.find((b) => b.banker.toLowerCase() === lc)
      ?? list.find((b) => b.name.toLowerCase() === lc)
      ?? (list.filter((b) => b.name.toLowerCase().includes(lc)).length === 1 ? list.find((b) => b.name.toLowerCase().includes(lc)) : undefined);
    if (!hit) { setNote({ ok: false, text: `No banker with the code or name “${t}”.` }); return; }
    setBanker(hit.banker);
    setReload((n) => n + 1);
    setNote({ ok: true, text: `Opened ${hit.name} (${hit.banker}).` });
    setTyped("");
  }

  return (
    <>
      <PageHeader title="MID switch" description={description} icon={ArrowRightLeft} />
      {portal?.base === "/merchant-portal" && <BankerSwitchCard />}
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          {list.length > 1 || q.data?.staff ? (
            <div className="min-w-[14rem]"><Label className="text-xs">Banker</Label>
              <select value={banker} onChange={(e) => { setBanker(e.target.value); setNote(null); }} className="w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm">
                {!list.some((b) => b.banker === banker) && banker && <option value={banker}>{banker}</option>}
                {list.map((b) => <option key={b.banker} value={b.banker}>{b.name} ({b.banker}) · {b.kinds.UPI.total} UPI · {b.kinds.GATEWAY.total} accounts</option>)}
              </select></div>
          ) : (
            <div className="text-sm"><span className="text-[color:var(--color-text-muted)]">Account:</span> <b>{list[0]?.name ?? "—"}</b> {list[0] && <span className="font-mono text-xs">({list[0].banker})</span>}</div>
          )}
          {q.data?.staff && (
            <form className="flex items-end gap-2" onSubmit={open}>
              <div><Label className="text-xs">Or any banker code</Label><Input value={typed} onChange={(e) => { setTyped(e.target.value); setNote(null); }} placeholder="M10001" /></div>
              <Button type="submit" size="sm" variant="secondary" disabled={!typed.trim()}>Open</Button>
            </form>
          )}
          {note && <div className={`w-full text-xs ${note.ok ? "text-[color:var(--color-text-muted)]" : "text-red-400"}`}>{note.text}</div>}
        </CardContent>
      </Card>
      {!portal && banker && <BankerSwitchCard key={`bs:${banker}`} banker={banker} />}
      {banker ? <MidSwitchPanel key={`${banker}:${reload}`} banker={banker} />
        : <Card><CardContent className="py-8 text-center text-sm text-[color:var(--color-text-muted)]">{q.isLoading ? "Loading…" : "No banker on this login yet."}</CardContent></Card>}
    </>
  );
}
