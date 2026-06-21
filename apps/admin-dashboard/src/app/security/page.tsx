"use client";

// Security center (PayTech BRD SEC-003/004). Enrol/disable TOTP MFA and review the
// devices bound to your account.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Smartphone, KeyRound, Check } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/utils";

export default function SecurityPage() {
  const qc = useQueryClient();
  const [enroll, setEnroll] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState("");
  const [disableCode, setDisableCode] = useState("");

  const status = useQuery({
    queryKey: ["mfa-status"],
    queryFn: async () => {
      const r = await fetch("/api/v1/mfa/status");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { email: string; enabled: boolean; enforced: boolean; sensitive_role: boolean; current_device: string | null; devices: any[] };
    },
  });

  const start = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/v1/mfa/enroll", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as { secret: string; otpauth: string };
    },
    onSuccess: (d) => setEnroll(d),
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const verify = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/v1/mfa/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: code }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d;
    },
    onSuccess: () => { toast.success("MFA enabled"); setEnroll(null); setCode(""); qc.invalidateQueries({ queryKey: ["mfa-status"] }); },
    onError: (e: Error) => toast.error("Invalid code", { description: e.message }),
  });

  const disable = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/v1/mfa/disable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: disableCode }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d;
    },
    onSuccess: () => { toast.success("MFA disabled"); setDisableCode(""); qc.invalidateQueries({ queryKey: ["mfa-status"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const st = status.data;

  return (
    <>
      <PageHeader title="Security" description="Multi-factor authentication and device binding (BRD SEC-003/004)." icon={ShieldCheck} />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><KeyRound className="h-4 w-4" /> Multi-factor authentication
            {st && <Badge variant={st.enabled ? "success" : "warning"}>{st.enabled ? "ENABLED" : "DISABLED"}</Badge>}
          </CardTitle>
          <CardDescription>
            {st?.enforced ? "Enforced for sensitive roles." : "Optional (enforcement off)."} {st?.sensitive_role ? "Your role is sensitive — MFA recommended." : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!st?.enabled && !enroll && <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}><KeyRound className="h-4 w-4" /> Set up MFA</Button>}

          {enroll && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="text-sm font-medium">1. Add this secret to your authenticator app</div>
              <div className="text-xs">Secret: <span className="font-mono select-all">{enroll.secret}</span></div>
              <div className="break-all text-xs text-[color:var(--color-text-muted)]">otpauth URI: <span className="font-mono select-all">{enroll.otpauth}</span></div>
              <div className="text-sm font-medium pt-2">2. Enter the current 6-digit code</div>
              <div className="flex items-center gap-2">
                <Input className="h-9 w-40" inputMode="numeric" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
                <Button size="sm" onClick={() => verify.mutate()} disabled={code.length < 6 || verify.isPending}><Check className="h-4 w-4" /> Verify & enable</Button>
              </div>
            </div>
          )}

          {st?.enabled && (
            <div className="flex items-center gap-2">
              <Input className="h-9 w-40" inputMode="numeric" placeholder="code to disable" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} />
              <Button size="sm" variant="danger" onClick={() => disable.mutate()} disabled={disableCode.length < 6 || disable.isPending}>Disable MFA</Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Smartphone className="h-4 w-4" /> Bound devices ({st?.devices?.length ?? 0})</CardTitle><CardDescription>Sessions are 8h; sensitive roles are bound to their device hash.</CardDescription></CardHeader>
        <CardContent className="space-y-1">
          {(st?.devices ?? []).length === 0 && <div className="rounded-md border px-3 py-2 text-xs text-[color:var(--color-text-muted)]">No devices recorded.</div>}
          {(st?.devices ?? []).map((d) => (
            <div key={d.device_hash} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs">{d.device_hash.slice(0, 12)}…</span>
                {d.device_hash === st?.current_device && <Badge variant="brand">this device</Badge>}
                <span className="text-xs text-[color:var(--color-text-muted)]">{d.label}</span>
              </div>
              <span className="text-xs text-[color:var(--color-text-muted)]">last {formatDateTime(d.last_seen)}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
