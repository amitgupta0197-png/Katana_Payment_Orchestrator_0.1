"use client";

// Merchant-portal "Transaction agent" card: lets the merchant DOWNLOAD the Katana
// Agent app and see whether their phone has granted the needed permissions. Reads the
// self-scoped /api/banker-portal/agent (merchant sees only their own devices).

import { useQuery } from "@tanstack/react-query";
import { Smartphone, Download, ShieldCheck, ShieldAlert, CheckCircle2, XCircle, Copy } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";

interface Device {
  device_id: string; label: string; status: string;
  notif_access: boolean | null; agent_enabled: boolean | null; app_version: string;
  last_heartbeat: string | null; online: boolean; permitted: boolean;
  // Payment apps the phone has capture engines enabled for. Empty = on-screen RRN capture
  // is paused on the device, so capture requests will expire unfulfilled no matter how
  // healthy the rest of the agent looks.
  capture_apps: string; auto_capture: boolean | null; rrn_capture_ready: boolean;
  // Device-reported capture counters. `dropped` = notifications that looked like money and
  // could not be parsed, i.e. payments this phone saw and lost.
  counters: Record<string, number> | null;
}

const MUTED = "text-[color:var(--color-text-muted)]";
const yn = (v: boolean | null) => (v === true ? "granted" : v === false ? "denied" : "unknown");
const ynVar = (v: boolean | null): "success" | "danger" | "warning" => v === true ? "success" : v === false ? "danger" : "warning";

export function MerchantPortalAgentCard() {
  const q = useQuery({
    queryKey: ["mp:agent"],
    queryFn: async () => {
      const r = await fetch("/api/banker-portal/agent");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as {
        merchant_code: string; devices: Device[]; any_permitted: boolean;
        unparsed?: { body: string; created_at: string }[];
      };
    },
    refetchInterval: 20_000,
  });
  const devices = q.data?.devices ?? [];
  const unparsed = q.data?.unparsed ?? [];
  const code = q.data?.merchant_code ?? "";
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  const copy = (t: string) => { navigator.clipboard?.writeText(t); toast.success("Copied"); };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">Transaction agent</CardTitle>
          <CardDescription>Install on your collection phone to auto-confirm UPI credits.</CardDescription>
        </div>
        {devices.length > 0 && (
          q.data?.any_permitted
            ? <Badge variant="success"><ShieldCheck className="mr-1 h-3.5 w-3.5" />Active</Badge>
            : <Badge variant="warning"><ShieldAlert className="mr-1 h-3.5 w-3.5" />Setup incomplete</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <Button asChild className="w-full">
          <a href="/katana-agent.apk" download><Download className="h-4 w-4" /> Download Android app (.apk)</a>
        </Button>

        <div className="rounded-md border p-3 text-sm">
          <div className={`mb-2 text-xs ${MUTED}`}>In the app settings, enter:</div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className={`w-24 text-xs ${MUTED}`}>Base URL</span>
              <code className="flex-1 truncate text-xs">{baseUrl}</code>
              <Button size="sm" variant="ghost" onClick={() => copy(baseUrl)}><Copy className="h-3.5 w-3.5" /></Button>
            </div>
            <div className="flex items-center gap-2">
              <span className={`w-24 text-xs ${MUTED}`}>Banker code</span>
              <code className="flex-1 truncate font-mono text-xs">{code || "—"}</code>
              <Button size="sm" variant="ghost" onClick={() => copy(code)}><Copy className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
          <div className={`mt-2 text-xs ${MUTED}`}>Then grant <span className="font-medium">Notification access</span> and keep the agent enabled.</div>
        </div>

        {devices.map((d) => (
          <div key={d.device_id} className="rounded-md border p-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5"><Smartphone className="h-3.5 w-3.5" /><span className="font-mono">{d.device_id}</span></span>
              <span className="inline-flex items-center gap-2">
                <Badge variant={d.online ? "success" : "default"}>{d.online ? "online" : "offline"}</Badge>
                {d.permitted ? <Badge variant="success"><CheckCircle2 className="mr-1 h-3 w-3" />ready</Badge> : <Badge variant="warning"><XCircle className="mr-1 h-3 w-3" />incomplete</Badge>}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>Approved: <Badge variant={d.status === "TRUSTED" ? "success" : "warning"}>{d.status === "TRUSTED" ? "yes" : "pending"}</Badge></span>
              <span>Notification access: <Badge variant={ynVar(d.notif_access)}>{yn(d.notif_access)}</Badge></span>
              <span>
                RRN capture:{" "}
                <Badge variant={d.rrn_capture_ready ? "success" : "warning"}>
                  {d.rrn_capture_ready
                    ? d.capture_apps
                    : !d.capture_apps ? "no payment app selected"
                    : d.auto_capture === false ? "auto-capture off"
                    : "not reported"}
                </Badge>
              </span>
              <span className={MUTED}>{d.last_heartbeat ? `seen ${formatDateTime(d.last_heartbeat)}` : "no heartbeat"}</span>
            </div>
            {d.counters && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className={MUTED}>
                  Notifications: seen {d.counters.seen ?? 0} · parsed {d.counters.parsed ?? 0} · forwarded {d.counters.uploaded ?? 0}
                </span>
                {(d.counters.dropped ?? 0) > 0 && (
                  <span>
                    dropped <Badge variant="danger">{d.counters.dropped}</Badge>
                  </span>
                )}
                {(d.counters.capture_try ?? 0) > 0 && (
                  <span className={MUTED}>
                    RRN captures: {d.counters.capture_ok ?? 0}/{d.counters.capture_try}
                    {(d.counters.capture_fail ?? 0) > 0 ? ` · ${d.counters.capture_fail} failed` : ""}
                  </span>
                )}
              </div>
            )}
            {(d.counters?.dropped ?? 0) > 0 && (
              <div className="mt-1.5 text-xs text-[color:var(--color-danger)]">
                This phone saw {d.counters!.dropped} payment notification(s) it could not read — those
                credits were lost. The formats are listed below; they need a parser update.
              </div>
            )}
            {!d.rrn_capture_ready && (
              <div className={`mt-1.5 text-xs ${MUTED}`}>
                {d.auto_capture === false
                  ? <>Auto-capture is off on this phone, so &ldquo;Get RRN&rdquo; requests are received and then
                      dropped. Turn on auto-capture in the agent and leave the payment app on its
                      payments list.</>
                  : <>RRN capture is paused on this phone. Open the agent, pick the payment app it
                      should read (e.g. Paytm Business) and turn on Accessibility for the agent —
                      until then &ldquo;Get RRN&rdquo; requests expire unanswered.</>}
              </div>
            )}
          </div>
        ))}

        {/* Notification formats the phone recognised as money but could not parse. Each one
            is a payment that was seen and lost — and each is a parser fix. Values are
            redacted on the device: long digit runs masked, VPAs replaced. */}
        {unparsed.length > 0 && (
          <div className="mt-4 rounded-lg border border-dashed p-3">
            <div className="text-xs font-semibold">
              Unreadable payment notifications ({unparsed.length})
            </div>
            <p className={`mt-1 text-xs ${MUTED}`}>
              The agent saw these, recognised an amount, and could not understand the format — so
              nothing was forwarded. Send these to support and the parser can be taught them.
            </p>
            <div className="mt-2 space-y-1.5">
              {unparsed.map((u, i) => (
                <div key={i} className="rounded-md bg-[color:var(--color-surface-muted)] p-2">
                  <div className={`text-[10px] ${MUTED}`}>{formatDateTime(u.created_at)}</div>
                  <div className="mt-0.5 break-words font-mono text-[11px]">{u.body}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
