"use client";

// "Test my integration" (merchant and banker portals): paste the order request you send and see if
// Katana would accept it, without making an order; and send yourself a test callback to see what
// your server answers. lib/integration-dryrun(-store). Names no gateway.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, FlaskConical, Send } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { InfoTip } from "@/components/ui/info-tip";
import type { DryRunResult } from "@/lib/integration-dryrun";

const MUTED = "text-[color:var(--color-text-muted)]";

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d as T;
}

interface CallbackAnswer { ok: boolean; target_url: string; http_status: number | null; duration_ms: number | null; body: string | null; error: string | null }

export function TestIntegration() {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"test" | "live">("test");
  const check = useMutation({ mutationFn: () => post<DryRunResult>("/api/portal/test-integration", { text, mode }) });
  const r = check.data;

  const bankers = useQuery({
    queryKey: ["portal", "webhook-settings"],
    queryFn: async () => {
      const res = await fetch("/api/portal/webhooks/settings");
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      return (d.settings ?? []) as { merchant_code: string; name: string; callback_url: string | null }[];
    },
  });
  const [code, setCode] = useState("");
  const chosen = code || bankers.data?.[0]?.merchant_code || "";
  const cb = useMutation({ mutationFn: () => post<CallbackAnswer>("/api/portal/test-integration/callback", { merchant_code: chosen }) });
  const target = bankers.data?.find((b) => b.merchant_code === chosen)?.callback_url ?? null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold"><FlaskConical className="h-5 w-5" /> Test my integration</h1>
        <p className={`text-sm ${MUTED}`}>Paste the order request your server sends. Katana checks it the way a real order is checked, but makes no order and moves no money.</p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-1.5 text-base">
            Check an order request
            <InfoTip label="this check">Paste the JSON body or the whole curl command from Postman. You see what Katana would say, and how to fix each problem.</InfoTip>
          </CardTitle>
          <CardDescription>Your keys stay private: the Salt is never shown.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} spellCheck={false}
            placeholder={'curl --location \'https://katanapay.co/api/v1/katana-pay/order\' \\\n--header \'Content-Type: application/json\' \\\n--data-raw \'{ "key": "mk_test_…", "txnid": "…", "amount": "1000", "hash": "…" }\''}
            className="w-full rounded-md border bg-[color:var(--color-surface)] p-3 font-mono text-xs" aria-label="Order request" />
          <div className="flex flex-wrap items-center gap-3">
            <div role="radiogroup" aria-label="Mode" className="inline-flex rounded-md border p-0.5">
              {(["test", "live"] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
                  className={`rounded px-2.5 py-1 text-xs font-medium ${mode === m ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]" : MUTED}`}>
                  {m === "test" ? "Test" : "Live"}
                </button>
              ))}
            </div>
            <InfoTip label="Test or Live">Your key decides the mode (mk_test_ or mk_live_). Pick what you meant; Katana tells you if the key says otherwise.</InfoTip>
            <Button onClick={() => check.mutate()} disabled={!text.trim() || check.isPending}>{check.isPending ? "Checking…" : "Check"}</Button>
          </div>
          {check.error && <p className="text-sm text-[color:var(--color-danger)]">{(check.error as Error).message}</p>}

          {r && (
            <div className="space-y-3 rounded-lg border p-3">
              <div className={`flex items-center gap-2 text-sm font-semibold ${r.accepted ? "text-[color:var(--color-success)]" : "text-[color:var(--color-danger)]"}`}>
                {r.accepted ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />} {r.headline}
              </div>
              {r.problems.length > 0 && (
                <ul className="space-y-2">
                  {r.problems.map((p, i) => (
                    <li key={i} className="rounded-md border border-[color:var(--color-danger)]/30 p-2 text-sm">
                      <div className="font-medium">{p.title} <span className={`font-mono text-xs ${MUTED}`}>{p.code}</span></div>
                      <div className={`break-words text-xs ${MUTED}`}>How to fix: {p.fix}</div>
                    </li>
                  ))}
                </ul>
              )}
              {r.notes.length > 0 && (
                <div>
                  <div className="text-xs font-medium">Good to know</div>
                  <ul className={`list-disc pl-5 text-xs ${MUTED}`}>{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                </div>
              )}
              {r.passed.length > 0 && (
                <div>
                  <div className="text-xs font-medium">Passed</div>
                  <ul className="space-y-0.5 text-xs">{r.passed.map((n, i) => <li key={i} className="flex gap-1.5"><span className="text-[color:var(--color-success)]">✓</span>{n}</li>)}</ul>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-1.5 text-base">
            Send me a test callback
            <InfoTip label="a test callback">Katana sends one sample &quot;paid&quot; message to your callback URL. It belongs to no real order. You see exactly what your server answered.</InfoTip>
          </CardTitle>
          <CardDescription>The message has the header X-Katana-Check: 1, so your server can tell it from a real one.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            {(bankers.data?.length ?? 0) > 1 && (
              <div className="space-y-1">
                <Label htmlFor="ti-banker">Account</Label>
                <select id="ti-banker" value={chosen} onChange={(e) => setCode(e.target.value)}
                  className="h-9 rounded-md border bg-[color:var(--color-surface)] px-2 text-sm">
                  {bankers.data!.map((b) => <option key={b.merchant_code} value={b.merchant_code}>{b.name} ({b.merchant_code})</option>)}
                </select>
              </div>
            )}
            <Button variant="secondary" onClick={() => cb.mutate()} disabled={!chosen || !target || cb.isPending}>
              <Send className="h-4 w-4" /> {cb.isPending ? "Sending…" : "Send test callback"}
            </Button>
          </div>
          <p className={`break-all text-xs ${MUTED}`}>{target ? `Goes to ${target}` : "No callback URL is set. Set one under Webhooks first."}</p>
          {cb.error && <p className="text-sm text-[color:var(--color-danger)]">{(cb.error as Error).message}</p>}
          {cb.data && (
            <div className="rounded-lg border p-3 text-sm">
              <div className={`font-medium ${cb.data.ok ? "text-[color:var(--color-success)]" : "text-[color:var(--color-danger)]"}`}>
                {cb.data.http_status ? `Your server answered ${cb.data.http_status}` : "Your server didn't answer"}
                {cb.data.duration_ms != null ? ` in ${(cb.data.duration_ms / 1000).toFixed(1)} s` : ""}
              </div>
              {cb.data.error && <div className={`text-xs ${MUTED}`}>{cb.data.error}</div>}
              {cb.data.body && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-[color:var(--color-surface-muted)] p-2 text-xs">{cb.data.body}</pre>}
              {!cb.data.ok && cb.data.http_status && cb.data.http_status >= 400 && cb.data.http_status < 500 && (
                <p className={`mt-1 text-xs ${MUTED}`}>A 4xx is fine if your server rejects unknown orders. For a real paid order it must answer 2xx.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
