"use client";

// Pick a payment gateway and enter its credentials. The fields follow lib/pg-catalog, so each
// gateway asks for exactly what it issues. Used for both the pay-in and the payout gateway.

import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GATEWAYS, type GatewayEnv, type GatewayId, type GatewayService } from "@/lib/pg-catalog";

export type GatewayKind = "payin" | "payout";
export interface GatewayForm { gateway: GatewayId; env: GatewayEnv; fields: Record<string, string> }

const selectCls = "flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]";

export function serviceOf(id: GatewayId, kind: GatewayKind): GatewayService | null {
  const g = GATEWAYS.find((x) => x.id === id);
  return (kind === "payin" ? g?.payin : g?.payout) ?? null;
}

export function GatewayCredentialsDialog({
  kind, merchantCode, configured, current, saving, onSave,
}: {
  kind: GatewayKind;
  merchantCode: string;
  configured: boolean;
  current?: GatewayId;
  saving: boolean;
  onSave: (form: GatewayForm) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [gateway, setGateway] = useState<GatewayId>(current ?? "PAYU");
  const [env, setEnv] = useState<GatewayEnv>("TEST");
  const [fields, setFields] = useState<Record<string, string>>({});

  // Start from the saved gateway each time the dialog opens; secrets are never prefilled.
  useEffect(() => { if (open) { setGateway(current ?? "PAYU"); setEnv("TEST"); setFields({}); } }, [open, current]);

  const svc = serviceOf(gateway, kind);
  const missing = !svc || svc.fields.some((f) => !f.optional && !(fields[f.name] ?? "").trim());
  const what = kind === "payin" ? "pay-in" : "payout";

  const save = async () => {
    try { await onSave({ gateway, env, fields }); setOpen(false); } catch { /* the caller shows the error */ }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={configured ? "secondary" : "default"}>
          <KeyRound className="h-4 w-4" /> {configured ? "Change" : "Connect gateway"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{configured ? "Change" : "Connect"} {what} gateway</DialogTitle>
          <DialogDescription>
            Credentials the gateway issued for <span className="font-mono">{merchantCode}</span>. Stored encrypted and never shown again.
            {configured && " Saving replaces the current gateway."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Gateway</Label>
              <select className={selectCls} value={gateway} onChange={(e) => { setGateway(e.target.value as GatewayId); setFields({}); }}>
                {GATEWAYS.map((g) => {
                  const s = kind === "payin" ? g.payin : g.payout;
                  return (
                    <option key={g.id} value={g.id} disabled={!s}>
                      {g.name}{!s ? " — no payouts" : !s.connector ? " — coming soon" : ""}
                    </option>
                  );
                })}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Environment</Label>
              <select className={selectCls} value={env} onChange={(e) => setEnv(e.target.value as GatewayEnv)}>
                <option value="TEST">{svc?.env.TEST ?? "Test"}</option>
                <option value="PROD">{svc?.env.PROD ?? "Live"}</option>
              </select>
            </div>
          </div>
          {svc && !svc.connector && (
            <div className="rounded-md border border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning-muted)] px-3 py-2 text-xs text-[color:var(--color-warning)]">
              Katana can save these now, but it doesn’t send {what}s through this gateway yet. Until its connector ships, this merchant keeps using Katana’s current {what} route.
            </div>
          )}
          {svc?.note && <div className="text-xs text-[color:var(--color-text-muted)]">{svc.note}</div>}
          {svc?.fields.map((f) => (
            <div key={`${gateway}-${f.name}`} className="space-y-1.5">
              <Label>{f.label}{f.optional && <span className="text-[color:var(--color-text-muted)]"> (optional)</span>}</Label>
              <Input
                type={f.secret ? "password" : "text"} autoComplete="off" placeholder={f.placeholder}
                value={fields[f.name] ?? ""} onChange={(e) => setFields({ ...fields, [f.name]: e.target.value })}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving || missing}>{saving ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
