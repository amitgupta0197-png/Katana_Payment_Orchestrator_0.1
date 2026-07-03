"use client";

// Merchant-portal "Transaction agent" card: lets the merchant DOWNLOAD the Katana
// Agent app and see whether their phone has granted the needed permissions. Reads the
// self-scoped /api/merchant-portal/agent (merchant sees only their own devices).

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
}

const MUTED = "text-[color:var(--color-text-muted)]";
const yn = (v: boolean | null) => (v === true ? "granted" : v === false ? "denied" : "unknown");
const ynVar = (v: boolean | null): "success" | "danger" | "warning" => v === true ? "success" : v === false ? "danger" : "warning";

export function MerchantPortalAgentCard() {
  const q = useQuery({
    queryKey: ["mp:agent"],
    queryFn: async () => {
      const r = await fetch("/api/merchant-portal/agent");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as { merchant_code: string; devices: Device[]; any_permitted: boolean };
    },
    refetchInterval: 20_000,
  });
  const devices = q.data?.devices ?? [];
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
              <span className={`w-24 text-xs ${MUTED}`}>Branch code</span>
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
              <span className={MUTED}>{d.last_heartbeat ? `seen ${formatDateTime(d.last_heartbeat)}` : "no heartbeat"}</span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
