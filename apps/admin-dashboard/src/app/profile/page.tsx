"use client";

// My Profile — self-serve account security for admin-dashboard personas.
//
// The merchant and banker portals already had this; the admin dashboard did not, so a
// Super Admin had no way to set their own password. That mattered once the shared
// demo-password fallback was closed in production (audit C5): a seeded account with a
// null hash could no longer sign in at all, and had no route to fix itself.
//
// Reuses the existing endpoints rather than adding new ones:
//   POST /api/me/password    — change own password (verifies the current one)
//   POST /api/me/logout-all  — revoke every other session for this user

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { KeyRound, UserRound, ShieldCheck, LogOut } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

interface Me {
  user: { id: string; email: string; full_name: string | null };
  persona: string;
  scope: { id: string | null; label: string | null };
}

export default function ProfilePage() {
  const [pw, setPw] = useState({ current_password: "", new_password: "", confirm: "" });

  const me = useQuery({
    queryKey: ["me:profile"],
    queryFn: async () => {
      const r = await fetch("/api/auth/me");
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as Me;
    },
  });

  const change = useMutation({
    mutationFn: async () => {
      // Checked here as well as server-side so the mismatch is caught before the
      // current password is sent anywhere.
      if (pw.new_password !== pw.confirm) throw new Error("new passwords do not match");
      if (pw.new_password === pw.current_password) throw new Error("new password must differ from the current one");
      const r = await fetch("/api/me/password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: pw.current_password, new_password: pw.new_password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d;
    },
    onSuccess: () => {
      toast.success("Password changed", {
        description: "Your other sessions were signed out. This one stays active.",
      });
      setPw({ current_password: "", new_password: "", confirm: "" });
    },
    onError: (e: Error) => toast.error("Could not change password", { description: e.message }),
  });

  const logoutAll = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/me/logout-all", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d;
    },
    onSuccess: () => toast.success("Other sessions signed out", { description: "Any other browser or device now has to sign in again." }),
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const u = me.data;
  const tooShort = pw.new_password.length > 0 && pw.new_password.length < 6;

  return (
    <>
      <PageHeader title="My Profile" description="Your account and sign-in security." icon={UserRound} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Signed in as</CardTitle>
            <CardDescription>The account this browser session belongs to.</CardDescription>
          </CardHeader>
          <CardContent>
            {me.isLoading ? (
              <div className="text-sm text-[color:var(--color-text-muted)]">Loading…</div>
            ) : (
              <dl className="space-y-2.5 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-[color:var(--color-text-muted)]">Name</dt>
                  <dd className="font-medium">{u?.user.full_name || "—"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-[color:var(--color-text-muted)]">Email</dt>
                  <dd className="font-medium">{u?.user.email}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-[color:var(--color-text-muted)]">Role</dt>
                  <dd><Badge variant="info">{u?.persona}</Badge></dd>
                </div>
                {u?.scope.label && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-[color:var(--color-text-muted)]">Scope</dt>
                    <dd className="font-medium">{u.scope.label}</dd>
                  </div>
                )}
              </dl>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" aria-hidden /> Change password</CardTitle>
            <CardDescription>Changing it signs out your other sessions; this one stays active.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cur">Current password</Label>
              <Input id="cur" type="password" autoComplete="current-password"
                value={pw.current_password}
                onChange={(e) => setPw({ ...pw, current_password: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new">New password</Label>
              <Input id="new" type="password" autoComplete="new-password" placeholder="at least 6 characters"
                value={pw.new_password}
                onChange={(e) => setPw({ ...pw, new_password: e.target.value })} />
              {tooShort && <p className="text-xs text-[color:var(--color-danger)]">Must be at least 6 characters.</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conf">Confirm new password</Label>
              <Input id="conf" type="password" autoComplete="new-password"
                value={pw.confirm}
                onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
              {pw.confirm.length > 0 && pw.confirm !== pw.new_password && (
                <p className="text-xs text-[color:var(--color-danger)]">Does not match.</p>
              )}
            </div>
            <div className="pt-1">
              <Button
                onClick={() => change.mutate()}
                disabled={
                  change.isPending || !pw.current_password ||
                  pw.new_password.length < 6 || pw.confirm !== pw.new_password
                }
              >
                {change.isPending ? "Changing…" : "Change password"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" aria-hidden /> Session security</CardTitle>
          <CardDescription>
            Use this if you have signed in on a shared or lost device. Every other session is
            invalidated immediately; the one you are using now is kept.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="secondary" onClick={() => logoutAll.mutate()} disabled={logoutAll.isPending}>
            <LogOut className="h-4 w-4" aria-hidden />
            {logoutAll.isPending ? "Signing out…" : "Sign out all other sessions"}
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
