"use client";

// Banker profile — change the password used to sign in (POST /api/me/password,
// works for any persona; requires the current password).

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, UserRound } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function BankerProfilePage() {
  const [pw, setPw] = useState({ current_password: "", new_password: "", confirm: "" });

  const change = useMutation({
    mutationFn: async () => {
      if (pw.new_password !== pw.confirm) throw new Error("new passwords do not match");
      const r = await fetch("/api/me/password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: pw.current_password, new_password: pw.new_password }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Password changed"); setPw({ current_password: "", new_password: "", confirm: "" }); },
    onError: (e: Error) => toast.error("Could not change password", { description: e.message }),
  });

  return (
    <>
      <PageHeader title="Profile" description="Manage how you sign in to the banker portal." icon={UserRound} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> Change password</CardTitle>
          <CardDescription>Update the password you use to sign in. If you signed in with a one-time password, set your own here.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>Current password</Label>
            <Input type="password" autoComplete="current-password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>New password</Label>
            <Input type="password" autoComplete="new-password" value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} placeholder="at least 6 characters" />
          </div>
          <div className="space-y-1.5">
            <Label>Confirm new password</Label>
            <Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
          </div>
          <div className="pt-2">
            <Button
              onClick={() => change.mutate()}
              disabled={change.isPending || !pw.current_password || pw.new_password.length < 6 || !pw.confirm}
            >
              {change.isPending ? "Changing…" : "Change password"}
            </Button>
          </div>
        </CardContent>
      </Card>
      <p className="mt-4 text-xs text-[color:var(--color-text-subtle)]">
        Forgot your password? Contact your Katana admin — they can issue you a new one-time password.
      </p>
    </>
  );
}
