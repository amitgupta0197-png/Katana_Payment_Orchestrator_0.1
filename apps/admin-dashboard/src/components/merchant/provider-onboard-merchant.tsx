"use client";

// Onboard a merchant directly under a given provider, from the provider window.
// Posts to /api/merchants with provider_id locked to this provider, so the new
// merchant is mapped to it immediately. Can be used controlled (pass open/
// onOpenChange) or self-triggered (renders its own button).

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

const BUSINESS_TYPES = ["PRIVATE_LIMITED", "PUBLIC_LIMITED", "LLP", "PARTNERSHIP", "SOLE_PROPRIETOR", "TRUST"];

export function ProviderOnboardMerchant({
  providerId, providerLabel, onCreated, open: controlledOpen, onOpenChange,
}: {
  providerId: string;
  providerLabel?: string;
  onCreated?: () => void;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  const isControlled = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;

  const [form, setForm] = useState({
    merchant_code: "", legal_name: "", brand_name: "", business_type: "PRIVATE_LIMITED",
    category_mcc: "5411", contact_email: "", contact_phone: "", website: "", registered_address: "",
  });

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/merchants", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, provider_id: providerId }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success(`Merchant onboarded under ${providerLabel ?? "provider"} — APPLICATION stage`);
      setOpen(false);
      setForm({ merchant_code: "", legal_name: "", brand_name: "", business_type: "PRIVATE_LIMITED",
        category_mcc: "5411", contact_email: "", contact_phone: "", website: "", registered_address: "" });
      onCreated?.();
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const valid = form.merchant_code.trim().length >= 2 && form.legal_name.trim().length >= 2 && /.+@.+\..+/.test(form.contact_email);

  return (
    <>
      {!isControlled && (
        <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Onboard branch</Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Onboard merchant under {providerLabel ?? "this provider"}</DialogTitle>
            <DialogDescription>
              Creates a branch at APPLICATION stage, mapped to this provider for traceability.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Branch code</Label>
              <Input value={form.merchant_code} onChange={(e) => setForm({ ...form, merchant_code: e.target.value.toUpperCase() })} placeholder="M-0001" />
            </div>
            <div className="space-y-1.5">
              <Label>Brand name</Label>
              <Input value={form.brand_name} onChange={(e) => setForm({ ...form, brand_name: e.target.value })} placeholder="(optional)" />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>Legal name</Label>
              <Input value={form.legal_name} onChange={(e) => setForm({ ...form, legal_name: e.target.value })} placeholder="Acme Pvt Ltd" />
            </div>
            <div className="space-y-1.5">
              <Label>Business type</Label>
              <select
                className="flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]"
                value={form.business_type}
                onChange={(e) => setForm({ ...form, business_type: e.target.value })}
              >
                {BUSINESS_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>MCC</Label>
              <Input value={form.category_mcc} onChange={(e) => setForm({ ...form, category_mcc: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Contact email</Label>
              <Input type="email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} placeholder="ops@acme.example" />
            </div>
            <div className="space-y-1.5">
              <Label>Contact phone</Label>
              <Input value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} placeholder="(optional)" />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>Website <span className="font-normal text-[color:var(--color-text-muted)]">(optional)</span></Label>
              <Input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://…" />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>Registered address <span className="font-normal text-[color:var(--color-text-muted)]">(optional)</span></Label>
              <Input value={form.registered_address} onChange={(e) => setForm({ ...form, registered_address: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => m.mutate()} disabled={m.isPending || !valid}>
              {m.isPending ? "Creating…" : "Submit application"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
