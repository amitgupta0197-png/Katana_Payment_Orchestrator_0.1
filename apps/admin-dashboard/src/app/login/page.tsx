"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const LANDING: Record<string, string> = {
  SUPER_ADMIN: "/",
  ADMIN: "/",
  PROVIDER: "/provider-portal",
  MERCHANT: "/merchant-portal",
  OPERATOR: "/operator",
  FINANCE: "/fifo-settlements",
  RISK: "/forensics",
  COMPLIANCE: "/forensics",
  SUPPORT: "/",
};

export default function LoginPage() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, totp: totp || undefined }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (body.mfa_required) setMfaRequired(true);
        throw new Error(body.error ?? "Sign-in failed");
      }
      router.push(next || LANDING[body.persona] || "/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[color:var(--color-surface-muted)] p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><LogIn className="h-5 w-5" /> Sign in</CardTitle>
          <CardDescription>Sign in to your Katana account.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {mfaRequired && (
              <div className="space-y-1.5">
                <Label htmlFor="totp">Authentication code</Label>
                <Input id="totp" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={totp} onChange={(e) => setTotp(e.target.value)} autoFocus />
              </div>
            )}
            {error && <div className="rounded-md border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger-muted)] px-3 py-2 text-xs text-[color:var(--color-danger)]">{error}</div>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
