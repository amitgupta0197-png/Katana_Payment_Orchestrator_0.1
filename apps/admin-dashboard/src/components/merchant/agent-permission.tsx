"use client";

// Merchant dashboard — "Transaction agent & permissions" section. Shows whether the
// merchant's forwarder device(s) have granted the permissions the SMS/notification
// reconciliation agent needs: device trust, notification access (device-reported),
// and heartbeat liveness. If nothing is enrolled, shows the setup details to give the
// merchant. Reads /api/merchants/[id]/devices.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Smartphone, ShieldCheck, ShieldAlert, CheckCircle2, XCircle, RefreshCw, Copy, Download, Trash2, Mail } from "lucide-react";
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

interface Inbox {
  email: string; auth_type: string; enabled: boolean; status: string | null;
  last_polled_at: string | null; polled_recently: boolean;
}

const MUTED = "text-[color:var(--color-text-muted)]";
const yn = (v: boolean | null) => (v === true ? "granted" : v === false ? "denied" : "unknown");
const ynVariant = (v: boolean | null): "success" | "danger" | "warning" =>
  v === true ? "success" : v === false ? "danger" : "warning";

export function MerchantAgentCard({ merchantId, merchantCode }: { merchantId: string; merchantCode: string }) {
  const q = useQuery({
    queryKey: ["merchant", merchantId, "devices"],
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/devices`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return (await r.json()) as { devices: Device[]; any_permitted: boolean; inboxes: Inbox[] };
    },
    refetchInterval: 20_000,
  });
  const qc = useQueryClient();
  const devices = q.data?.devices ?? [];
  const inboxes: Inbox[] = (q.data as any)?.inboxes ?? [];
  const anyPermitted = q.data?.any_permitted ?? false;
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  const copy = (t: string) => { navigator.clipboard?.writeText(t); toast.success("Copied"); };

  const remove = useMutation({
    mutationFn: async (deviceId: string) => {
      const r = await fetch(`/api/merchants/${merchantId}/devices?device_id=${encodeURIComponent(deviceId)}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Device removed"); qc.invalidateQueries({ queryKey: ["merchant", merchantId, "devices"] }); },
    onError: (e: Error) => toast.error("Could not remove device", { description: e.message }),
  });

  // Trust / revoke a forwarder device (admin action). TRUSTED enables auto-confirm;
  // REVOKED forces every alert from it to manual review. Also binds the device to this
  // merchant so it shows under the right account.
  const setTrust = useMutation({
    mutationFn: async ({ deviceId, status }: { deviceId: string; status: "TRUSTED" | "REVOKED" }) => {
      const r = await fetch(`/api/v1/recon/devices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_id: deviceId, status, merchant_id: merchantCode }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: (_d, v) => {
      toast.success(v.status === "TRUSTED" ? "Device trusted — it can now auto-confirm payments" : "Device trust revoked");
      qc.invalidateQueries({ queryKey: ["merchant", merchantId, "devices"] });
    },
    onError: (e: Error) => toast.error("Could not update trust", { description: e.message }),
  });

  // Disconnect a connected email inbox.
  const removeInbox = useMutation({
    mutationFn: async (email: string) => {
      const r = await fetch(`/api/merchants/${merchantId}/devices?email=${encodeURIComponent(email)}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Email disconnected"); qc.invalidateQueries({ queryKey: ["merchant", merchantId, "devices"] }); },
    onError: (e: Error) => toast.error("Could not disconnect", { description: e.message }),
  });

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">Transaction agent &amp; permissions</CardTitle>
          <CardDescription>Whether this merchant&apos;s forwarder device has granted the SMS/notification reconciliation permissions.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="secondary" title="Download the Katana Agent APK">
            <a href="/katana-agent.apk" download><Download className="h-3.5 w-3.5" /> Download app</a>
          </Button>
          {devices.length > 0 && (
            anyPermitted
              ? <Badge variant="success"><ShieldCheck className="mr-1 h-3.5 w-3.5" />Permissions granted</Badge>
              : <Badge variant="warning"><ShieldAlert className="mr-1 h-3.5 w-3.5" />Action needed</Badge>
          )}
          <Button size="sm" variant="ghost" title="Refresh" onClick={() => q.refetch()}><RefreshCw className="h-3.5 w-3.5" /></Button>
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className={`py-3 text-center text-sm ${MUTED}`}>Loading…</div>
        ) : devices.length === 0 ? (
          <div className="rounded-md border border-dashed p-3 text-sm">
            <div className="mb-2 font-medium">No forwarder device enrolled yet.</div>
            <div className={`mb-2 text-xs ${MUTED}`}>Install the Katana Agent on the merchant&apos;s phone and enter these in its settings:</div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className={`w-28 text-xs ${MUTED}`}>Base URL</span>
                <code className="flex-1 truncate text-xs">{baseUrl}</code>
                <Button size="sm" variant="ghost" onClick={() => copy(baseUrl)}><Copy className="h-3.5 w-3.5" /></Button>
              </div>
              <div className="flex items-center gap-2">
                <span className={`w-28 text-xs ${MUTED}`}>Branch code</span>
                <code className="flex-1 truncate text-xs font-mono">{merchantCode}</code>
                <Button size="sm" variant="ghost" onClick={() => copy(merchantCode)}><Copy className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
            <div className="mt-3">
              <Button asChild size="sm"><a href="/katana-agent.apk" download><Download className="h-4 w-4" /> Download agent APK</a></Button>
            </div>
            <div className={`mt-2 text-xs ${MUTED}`}>The device appears here once it sends its first heartbeat. A Super-Admin then trusts it under Transaction Intel → Devices.</div>
          </div>
        ) : (
          <ul className="space-y-2">
            {devices.map((d) => (
              <li key={d.device_id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Smartphone className="h-4 w-4" />
                    <span className="font-mono text-sm">{d.device_id}</span>
                    {d.label && <span className={`text-xs ${MUTED}`}>{d.label}</span>}
                    {d.permitted
                      ? <Badge variant="success"><CheckCircle2 className="mr-1 h-3 w-3" />ready</Badge>
                      : <Badge variant="warning"><XCircle className="mr-1 h-3 w-3" />incomplete</Badge>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={d.online ? "success" : "default"}>{d.online ? "online" : "offline"}</Badge>
                    {d.status !== "TRUSTED" ? (
                      <Button size="sm" title="Trust this device so it can auto-confirm payments"
                        disabled={setTrust.isPending}
                        onClick={() => setTrust.mutate({ deviceId: d.device_id, status: "TRUSTED" })}>
                        <ShieldCheck className="h-3.5 w-3.5" /> Trust
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" title="Revoke trust — alerts will route to manual review"
                        disabled={setTrust.isPending}
                        onClick={() => { if (confirm(`Revoke trust for ${d.device_id}? It will no longer auto-confirm payments.`)) setTrust.mutate({ deviceId: d.device_id, status: "REVOKED" }); }}>
                        <ShieldAlert className="h-3.5 w-3.5" /> Revoke
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" title="Remove device (e.g. app uninstalled)"
                      disabled={remove.isPending}
                      onClick={() => { if (confirm(`Remove device ${d.device_id}? It will re-enrol if the app is still installed.`)) remove.mutate(d.device_id); }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <span>Trust: <Badge variant={d.status === "TRUSTED" ? "success" : d.status === "SUSPENDED" || d.status === "REVOKED" ? "danger" : "warning"}>{d.status}</Badge></span>
                  <span>Notification access: <Badge variant={ynVariant(d.notif_access)}>{yn(d.notif_access)}</Badge></span>
                  <span>Forwarding: <Badge variant={ynVariant(d.agent_enabled)}>{yn(d.agent_enabled)}</Badge></span>
                  <span className={MUTED}>{d.last_heartbeat ? `last heartbeat ${formatDateTime(d.last_heartbeat)}` : "no heartbeat"}</span>
                  {d.app_version && <span className={MUTED}>v{d.app_version}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}

        {inboxes.length > 0 && (
          <div className="mt-3 border-t pt-3">
            <div className={`mb-2 flex items-center gap-2 text-xs font-medium ${MUTED}`}>
              <Mail className="h-3.5 w-3.5" /> Email channel (no phone needed)
            </div>
            <ul className="space-y-2">
              {inboxes.map((ib) => (
                <li key={ib.email} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Mail className="h-4 w-4" />
                    <span className="text-sm">{ib.email}</span>
                    <Badge variant="default">{ib.auth_type === "OAUTH" ? "Google" : "App password"}</Badge>
                    {ib.status === "OK"
                      ? <Badge variant="success"><CheckCircle2 className="mr-1 h-3 w-3" />connected</Badge>
                      : <Badge variant="warning"><XCircle className="mr-1 h-3 w-3" />{ib.status ?? "pending"}</Badge>}
                    <span className={`text-xs ${MUTED}`}>{ib.last_polled_at ? `last checked ${formatDateTime(ib.last_polled_at)}` : "not checked yet"}</span>
                  </div>
                  <Button size="sm" variant="ghost" title="Disconnect this email"
                    disabled={removeInbox.isPending}
                    onClick={() => { if (confirm(`Disconnect ${ib.email}? Payment emails will no longer be read.`)) removeInbox.mutate(ib.email); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
