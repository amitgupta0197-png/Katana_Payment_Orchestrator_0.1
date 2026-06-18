"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserCog } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { statusVariant } from "@/lib/utils";

interface Merchant {
  id: string; merchant_code: string; legal_name: string; brand_name?: string;
  contact_email: string; contact_phone?: string;
  category_mcc?: string; risk_tier?: string; stage: string;
}

export default function ProfilePage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["mp:merchant"],
    queryFn: async () => (await fetch("/api/merchants").then(async (r) => { const _d = await r.json().catch(() => null); if (!r.ok) throw new Error((_d && _d.error) || ("HTTP " + r.status)); return _d; })) as { merchants: Merchant[] },
  });
  const me = q.data?.merchants?.[0];

  const [form, setForm] = useState({ contact_email: "", contact_phone: "", webhook_url: "", return_url: "" });
  useEffect(() => {
    if (me) setForm((f) => ({ ...f, contact_email: me.contact_email, contact_phone: me.contact_phone ?? "" }));
  }, [me]);

  const m = useMutation({
    mutationFn: async () => {
      if (!me) throw new Error("no merchant");
      const r = await fetch(`/api/merchants/${me.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => { toast.success("Profile saved"); qc.invalidateQueries({ queryKey: ["mp:merchant"] }); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  return (
    <>
      <PageHeader title="Profile" description="Contact details, webhook URL, return URL." icon={UserCog} />
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>{me?.brand_name ?? me?.legal_name ?? "—"}</CardTitle>
          <CardDescription>
            {me?.merchant_code ?? "—"} · MCC: {me?.category_mcc ?? "—"} · Stage:{" "}
            <Badge variant={statusVariant(me?.stage)}>{me?.stage ?? "—"}</Badge>{" "}
            · Risk: <Badge variant={statusVariant(me?.risk_tier)}>{me?.risk_tier ?? "—"}</Badge>
          </CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader><CardTitle>Editable fields</CardTitle><CardDescription>Per §3.3: merchants may edit contact + webhook only.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>Contact email</Label>
            <Input type="email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Contact phone</Label>
            <Input value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Webhook URL (must be HTTPS)</Label>
            <Input value={form.webhook_url} onChange={(e) => setForm({ ...form, webhook_url: e.target.value })} placeholder="https://api.your-merchant.com/katana/webhook" />
          </div>
          <div className="space-y-1.5">
            <Label>Return URL</Label>
            <Input value={form.return_url} onChange={(e) => setForm({ ...form, return_url: e.target.value })} placeholder="https://checkout.your-merchant.com/return" />
          </div>
          <div className="pt-2">
            <Button onClick={() => m.mutate()} disabled={m.isPending || !me}>{m.isPending ? "Saving…" : "Save"}</Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
