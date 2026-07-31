"use client";

// Admin control to set / reset the login password for a provider or merchant, and
// provision the login if it doesn't exist yet. SUPER_ADMIN only (backed by
// /api/admin/set-password). The resulting password is shown once so the admin can
// share it with the provider/merchant.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, Copy, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  email: string;
  kind: "MERCHANT" | "PROVIDER";
  scopeId: string;       // merchant_code for MERCHANT, provider id (uuid) for PROVIDER
  scopeLabel?: string;
  fullName?: string;
}

export function SetLoginPasswordCard({ email, kind, scopeId, scopeLabel, fullName }: Props) {
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<{ password: string; generated: boolean; created_user: boolean } | null>(null);

  const m = useMutation({
    mutationFn: async (generate: boolean) => {
      const r = await fetch("/api/admin/set-password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password: generate ? undefined : password,
          kind, scope_id: scopeId, scope_label: scopeLabel, full_name: fullName,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as { email: string; password: string; generated: boolean; created_user: boolean };
    },
    onSuccess: (d) => {
      setResult(d);
      setPassword("");
      toast.success(d.created_user ? "Login created" : "Password updated");
    },
    onError: (e: Error) => toast.error("Could not set password", { description: e.message }),
  });

  const copy = (t: string) => { navigator.clipboard?.writeText(t); toast.success("Copied"); };
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" /> Login &amp; password</CardTitle>
        <CardDescription>
          Set or reset the sign-in password for <span className="font-mono">{email}</span>. Creates the login if it doesn&rsquo;t exist yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1 space-y-1.5">
            <Label>New password</Label>
            <Input type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="type a password (min 6 chars)" />
          </div>
          <Button onClick={() => m.mutate(false)} disabled={m.isPending || password.length < 6}>
            {m.isPending ? "Saving…" : "Set password"}
          </Button>
          <Button variant="secondary" onClick={() => m.mutate(true)} disabled={m.isPending} title="Generate a random password">
            <Wand2 className="h-4 w-4" /> Generate
          </Button>
        </div>

        {result && (
          <div className="space-y-2 rounded-md border bg-[color:var(--color-surface-muted)] p-3">
            <div className="text-xs text-[color:var(--color-text-muted)]">
              {result.created_user ? "Login created." : "Password updated."} Share these with the {kind.toLowerCase()} — the password won&rsquo;t be shown again.
            </div>
            <CredRow label="Login URL" value={`${origin}/login`} onCopy={copy} />
            <CredRow label="Email" value={email} onCopy={copy} />
            <CredRow label="Password" value={result.password} onCopy={copy} mono />
            <Button variant="secondary" size="sm" className="w-full" onClick={() => copy(`Katana login\nURL: ${origin}/login\nEmail: ${email}\nPassword: ${result.password}`)}>
              <Copy className="h-4 w-4" /> Copy all
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CredRow({ label, value, onCopy, mono }: { label: string; value: string; onCopy: (t: string) => void; mono?: boolean }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <code className={`flex-1 truncate rounded-md border bg-[color:var(--color-surface)] px-2 py-1.5 text-xs ${mono ? "font-semibold" : ""}`}>{value}</code>
        <Button size="sm" variant="ghost" onClick={() => onCopy(value)}><Copy className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}
