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

interface Summary { banker: string; name: string; kinds: Record<"GATEWAY" | "UPI", { total: number; active: number }> }

export function MidSwitchPage({ description }: { description: string }) {
  const q = useQuery({
    queryKey: ["mid-switch-bankers"],
    queryFn: async () => (await fetch("/api/mid-switch").then((r) => r.json())) as { bankers: Summary[]; staff: boolean },
  });
  const [banker, setBanker] = useState("");
  const [typed, setTyped] = useState("");
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("banker");
    if (fromUrl) setBanker(fromUrl);
  }, []);
  useEffect(() => { if (!banker && q.data?.bankers.length) setBanker(q.data.bankers[0].banker); }, [banker, q.data]);
  const list = q.data?.bankers ?? [];

  return (
    <>
      <PageHeader title="MID switch" description={description} icon={ArrowRightLeft} />
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          {list.length > 1 || q.data?.staff ? (
            <div className="min-w-[14rem]"><Label className="text-xs">Banker</Label>
              <select value={banker} onChange={(e) => setBanker(e.target.value)} className="w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm">
                {!list.some((b) => b.banker === banker) && banker && <option value={banker}>{banker}</option>}
                {list.map((b) => <option key={b.banker} value={b.banker}>{b.name} ({b.banker}) · {b.kinds.UPI.total} UPI · {b.kinds.GATEWAY.total} accounts</option>)}
              </select></div>
          ) : (
            <div className="text-sm"><span className="text-[color:var(--color-text-muted)]">Account:</span> <b>{list[0]?.name ?? "—"}</b> {list[0] && <span className="font-mono text-xs">({list[0].banker})</span>}</div>
          )}
          {q.data?.staff && (
            <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) setBanker(typed.trim()); }}>
              <div><Label className="text-xs">Or any banker code</Label><Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="M10001" /></div>
              <Button type="submit" size="sm" variant="secondary">Open</Button>
            </form>
          )}
        </CardContent>
      </Card>
      {banker ? <MidSwitchPanel key={banker} banker={banker} />
        : <Card><CardContent className="py-8 text-center text-sm text-[color:var(--color-text-muted)]">{q.isLoading ? "Loading…" : "No banker on this login yet."}</CardContent></Card>}
    </>
  );
}
