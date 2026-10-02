"use client";

// Webhooks and API keys for the bankers in scope (lib/webhook-settings, lib/v2-keys,
// lib/webhook-test): where callbacks go, which contract they are sent in, which outcomes are
// sent, the v2 signing secret, sample events, and the keys the v2 order API is called with.
//
// Shared by the merchant portal and the banker portal. A secret or a key is shown once, when it
// is made, and is not readable afterwards.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Webhook, KeyRound, Copy } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TestEventButton } from "@/components/portal/test-event-button";
import { formatDateTime } from "@/lib/utils";
import { DeliveryList } from "@/components/portal/order-desk";

interface Settings {
  merchant_code: string; name: string; webhook_version: "v1" | "v2"; effective_version: "v1" | "v2"; webhook_events: "ALL" | "PAID_ONLY";
  callback_url: string | null; has_secret: boolean; secret_hint: string | null;
}
interface Key { id: string; label: string; prefix: string; livemode: boolean; status: string; created_at: string; last_used_at: string | null }

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? d.message ?? "HTTP " + r.status);
  return d as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** A secret shown once: copy it now. */
function Once({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  return (
    <div className="rounded-md border border-[color:var(--color-warning)] bg-[color:var(--color-warning-muted)] p-3 text-sm">
      <div className="font-medium">{label}: copy it now, it is not shown again</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="break-all rounded bg-[color:var(--color-surface)] px-2 py-1 text-xs">{value}</code>
        <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard.writeText(value); toast.success("Copied"); }}><Copy className="h-3.5 w-3.5" /> Copy</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>I have saved it</Button>
      </div>
    </div>
  );
}

function Choice<T extends string>({ value, options, onChange, disabled }: {
  value: T; options: { value: T; label: string; hint: string }[]; onChange: (v: T) => void; disabled?: boolean;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((o) => (
        <button key={o.value} type="button" disabled={disabled} onClick={() => o.value !== value && onChange(o.value)}
          aria-pressed={o.value === value}
          className={`rounded-md border p-3 text-left text-sm transition-colors ${o.value === value
            ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)]"
            : "hover:bg-[color:var(--color-surface-muted)]"}`}>
          <div className="font-medium">{o.label}</div>
          <div className="mt-0.5 text-xs text-[color:var(--color-text-muted)]">{o.hint}</div>
        </button>
      ))}
    </div>
  );
}

function BankerWebhooks({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(s.callback_url ?? "");
  const [secret, setSecret] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["portal:webhook-settings"] });

  const save = useMutation({
    mutationFn: (change: Partial<Pick<Settings, "webhook_version" | "webhook_events">> & { callback_url?: string }) =>
      call<{ settings: Settings; secret?: string }>("/api/portal/webhooks/settings", json("PATCH", { merchant_code: s.merchant_code, ...change })),
    onSuccess: (d) => { if (d.secret) setSecret(d.secret); toast.success("Saved"); refresh(); },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });
  const rotate = useMutation({
    mutationFn: () => call<{ secret: string }>("/api/portal/webhooks/secret", json("POST", { merchant_code: s.merchant_code })),
    onSuccess: (d) => { setSecret(d.secret); refresh(); },
    onError: (e: Error) => toast.error("Not replaced", { description: e.message }),
  });
  const tests = useQuery({
    queryKey: ["portal:webhook-tests", s.merchant_code],
    queryFn: () => call<{ tests: Parameters<typeof DeliveryList>[0]["deliveries"] }>(`/api/portal/webhooks/test?merchant_code=${encodeURIComponent(s.merchant_code)}`),
  });
  const busy = save.isPending || rotate.isPending;

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Webhook className="h-4 w-4" /> {s.name} <span className="font-mono text-xs font-normal text-[color:var(--color-text-muted)]">{s.merchant_code}</span>
          <Badge variant={s.webhook_version === "v2" ? "brand" : "default"}>webhook {s.webhook_version}</Badge>
        </CardTitle>
        <CardDescription>Webhooks are notifications; they can fail or retry. Always confirm an order by reading its status before fulfilling.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {secret && <Once label="Webhook signing secret" value={secret} onDone={() => setSecret(null)} />}

        <div>
          <div className="mb-1.5 text-sm font-medium">Callback URL</div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate({ callback_url: url.trim() }); }}>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-server.example/katana/webhook" aria-label="Callback URL" />
            <Button type="submit" variant="secondary" disabled={busy || url.trim() === (s.callback_url ?? "")}>Save</Button>
          </form>
          <p className="mt-1 text-xs text-[color:var(--color-text-muted)]">Used when an order is created without its own callback_url.</p>
        </div>

        <div>
          <div className="mb-1.5 text-sm font-medium">Webhook version</div>
          <Choice value={s.webhook_version} disabled={busy} onChange={(v) => save.mutate({ webhook_version: v })} options={[
            { value: "v1", label: "v1", hint: "The original callback: STATUS and a HASH in the body, signed with your Salt." },
            { value: "v2", label: "v2", hint: "payment.success / payment.failed / payment.expired, signed in the X-Katana-Signature header." },
          ]} />
        </div>

        <div>
          <div className="mb-1.5 text-sm font-medium">Events</div>
          <Choice value={s.webhook_events} disabled={busy} onChange={(v) => save.mutate({ webhook_events: v })} options={[
            { value: "ALL", label: "Receive all outcomes", hint: "Success, failed and expired." },
            { value: "PAID_ONLY", label: "Receive paid only", hint: "Success only. Read the status of the others from the status API." },
          ]} />
        </div>

        {s.webhook_version === "v2" && s.effective_version === "v1" && (
          <div role="status" className="rounded-md border border-[color:var(--color-warning)] bg-[color:var(--color-warning-muted)] p-3 text-sm">
            v2 is selected but there is no signing secret yet, so the v1 callback is still being sent. Create the secret to start receiving v2 events.
          </div>
        )}

        {s.webhook_version === "v2" && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Signing secret</span>
            <span className="font-mono text-xs text-[color:var(--color-text-muted)]">{s.secret_hint ?? "none yet"}</span>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => { if (!s.has_secret || window.confirm("Replace the signing secret? Deliveries signed with the old one will stop verifying on your server.")) rotate.mutate(); }}>
              {s.has_secret ? "Replace secret" : "Create secret"}
            </Button>
          </div>
        )}

        <div>
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Test events</span>
            <TestEventButton merchantCode={s.merchant_code} disabled={!s.callback_url} />
            {!s.callback_url && <span className="text-xs text-[color:var(--color-text-muted)]">Save a callback URL first.</span>}
          </div>
          <p className="mb-2 text-xs text-[color:var(--color-text-muted)]">A sample is sent to your callback URL in your webhook version. It belongs to no order and changes none.</p>
          {(tests.data?.tests.length ?? 0) > 0 && <DeliveryList deliveries={tests.data!.tests} staff={false} />}
        </div>

        <ApiKeys merchantCode={s.merchant_code} />
      </CardContent>
    </Card>
  );
}

function ApiKeys({ merchantCode }: { merchantCode: string }) {
  const qc = useQueryClient();
  const [secret, setSecret] = useState<string | null>(null);
  const key = ["portal:keys", merchantCode];
  const q = useQuery({ queryKey: key, queryFn: () => call<{ keys: Key[] }>(`/api/portal/keys?merchant_code=${encodeURIComponent(merchantCode)}`) });
  const issue = useMutation({
    mutationFn: (livemode: boolean) => call<{ secret: string }>("/api/portal/keys", json("POST", { merchant_code: merchantCode, livemode, label: livemode ? "Live key" : "Test key" })),
    onSuccess: (d) => { setSecret(d.secret); qc.invalidateQueries({ queryKey: key }); },
    onError: (e: Error) => toast.error("Key not created", { description: e.message }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => call(`/api/portal/keys?merchant_code=${encodeURIComponent(merchantCode)}&id=${id}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("Key revoked"); qc.invalidateQueries({ queryKey: key }); },
    onError: (e: Error) => toast.error("Not revoked", { description: e.message }),
  });
  const keys = (q.data?.keys ?? []).filter((k) => k.status === "ACTIVE");
  return (
    <div className="border-t pt-4">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium"><KeyRound className="h-4 w-4" /> API keys (v2)</span>
        <Button size="sm" variant="secondary" disabled={issue.isPending} onClick={() => issue.mutate(false)}>New test key</Button>
        <Button size="sm" variant="secondary" disabled={issue.isPending} onClick={() => issue.mutate(true)}>New live key</Button>
      </div>
      <p className="mb-2 text-xs text-[color:var(--color-text-muted)]">Sent as <code>Authorization: Bearer &lt;key&gt;</code>. The key decides whether an order is test or live.</p>
      {secret && <div className="mb-2"><Once label="API key" value={secret} onDone={() => setSecret(null)} /></div>}
      {keys.length === 0 ? <p className="text-xs text-[color:var(--color-text-muted)]">No key yet.</p> : (
        <ul className="divide-y divide-[color:var(--color-border)] rounded-md border text-sm">
          {keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <Badge variant={k.livemode ? "success" : "warning"}>{k.livemode ? "LIVE" : "TEST"}</Badge>
              <span className="font-mono text-xs">{k.prefix}…</span>
              <span className="text-xs text-[color:var(--color-text-muted)]">created {formatDateTime(k.created_at)} · {k.last_used_at ? `last used ${formatDateTime(k.last_used_at)}` : "never used"}</span>
              <Button size="sm" variant="ghost" className="ml-auto text-[color:var(--color-danger)]" disabled={revoke.isPending}
                onClick={() => { if (window.confirm("Revoke this key? Requests signed with it will be refused.")) revoke.mutate(k.id); }}>Revoke</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * `staff`: the same page for Katana staff, who choose the banker by its code. A merchant or
 * banker login gets its own accounts without choosing.
 */
export function WebhooksPanel({ staff = false }: { staff?: boolean }) {
  const [text, setText] = useState("");
  const [code, setCode] = useState("");
  const q = useQuery({
    queryKey: ["portal:webhook-settings", code],
    enabled: !staff || code.length > 0,
    queryFn: () => call<{ settings: Settings[] }>(`/api/portal/webhooks/settings${staff ? `?merchant_code=${encodeURIComponent(code)}` : ""}`),
  });
  const list = q.data?.settings ?? [];
  return (
    <>
      <PageHeader title={staff ? "Webhook settings" : "Webhooks & API keys"} icon={Webhook}
        description="Where Katana tells your server about a payment, in which format, and the keys your server calls the order API with."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="secondary"><a href="/katana-v2-guide.html" target="_blank" rel="noreferrer">API v2 guide</a></Button>
            <Button asChild size="sm" variant="secondary"><a href="/Katana-API-v2-Guide.pdf" target="_blank" rel="noreferrer">PDF</a></Button>
          </div>
        } />
      {staff && (
        <form className="mb-4 flex max-w-md gap-2" onSubmit={(e) => { e.preventDefault(); setCode(text.trim()); }}>
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Banker code" aria-label="Banker code" />
          <Button type="submit" variant="secondary" disabled={!text.trim()}>Open</Button>
        </form>
      )}
      {staff && !code ? <p className="text-sm text-[color:var(--color-text-muted)]">Enter a banker code to see and change its webhook settings and keys.</p>
        : q.isLoading ? <p className="text-sm text-[color:var(--color-text-muted)]">Loading…</p>
        : q.error ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>
        : list.length === 0 ? <Card><CardContent className="p-4 text-sm">{staff ? `No banker with the code ${code}.` : "No account is set up under this login yet."}</CardContent></Card>
        : list.map((s) => <BankerWebhooks key={s.merchant_code} s={s} />)}
    </>
  );
}
