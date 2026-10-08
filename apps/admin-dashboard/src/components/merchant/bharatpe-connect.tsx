"use client";

// BharatPe for one banker, in plain words (lib/bharatpe-setup, /api/merchants/{id}/bharatpe).
//
// BharatPe has no API: the customer pays the banker's BharatPe QR, and the Katana agent app captures
// the payment on the merchant's own device and posts it back to confirm the order. This card sets the
// BharatPe UPI ID as the banker's P2P payee and mints the per-MID API key + secret the agent signs
// its posts with. Staff only (Super Admin). The secret is shown once, here, and never again.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, KeyRound, Plug, Smartphone } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface MidRow { id: string; label: string; bharatpe_merchant_id: string | null; payee_vpa: string; env: "PROD" | "TEST"; status: "ACTIVE" | "DISABLED"; api_key_hint: string }
interface State { banker: string; mids: MidRow[]; settlement_vpa: string | null; ingest_url: string }
interface SaveResult { mid: MidRow; api_key: string | null; secret: string | null; ingest_url: string }

const muted = "text-[color:var(--color-text-muted)]";

async function readJson<T>(r: Response): Promise<T> {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error ?? "HTTP " + r.status), { body: d });
  return d as T;
}
const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast.success("Copied"), () => toast.error("Could not copy"));

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={cn("w-32 shrink-0", muted)}>{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-[color:var(--color-surface-muted)] px-2 py-1 text-xs">{value}</code>
      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copy(value)} aria-label={`Copy ${label}`}><Copy /></Button>
    </div>
  );
}

export function BharatPeConnectCard({ merchantId }: { merchantId: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ["bharatpe", merchantId], queryFn: async () => readJson<State>(await fetch(`/api/merchants/${merchantId}/bharatpe`)) });
  if (q.isLoading) return null;
  if (q.error) return null;   // not Super Admin, or no such banker
  const s = q.data!;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><Smartphone className="size-4" /> BharatPe</CardTitle>
            <CardDescription>
              The customer pays the banker&rsquo;s BharatPe QR; the Katana agent app reads the payment on the
              merchant&rsquo;s phone and reports it to confirm the order. No gateway, no BharatPe login.
            </CardDescription>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            <Plug className="size-4" /> {s.mids.length ? "Add a MID" : "Connect BharatPe"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {s.mids.length === 0 ? (
          <p className={cn("text-sm", muted)}>No BharatPe MID yet. Connect one to set the BharatPe UPI ID as the payee and get the agent&rsquo;s key.</p>
        ) : (
          <div className="space-y-2">
            {s.mids.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                <span className="font-medium">{m.label}</span>
                <Badge variant={m.env === "PROD" ? "default" : "info"}>{m.env === "PROD" ? "Live" : "Test"}</Badge>
                {m.status === "DISABLED" && <Badge variant="danger">Paused</Badge>}
                {s.settlement_vpa === m.payee_vpa && <Badge variant="brand">Payee</Badge>}
                <span className={muted}>{m.payee_vpa}</span>
                <span className={cn("ml-auto flex items-center gap-1 text-xs", muted)}><KeyRound className="size-3" /> {m.api_key_hint}</span>
              </div>
            ))}
          </div>
        )}
        <div className="rounded-md bg-[color:var(--color-surface-muted)] p-3">
          <CopyRow label="Agent posts to" value={s.ingest_url} />
          <p className={cn("mt-2 text-xs", muted)}>
            The agent signs each credit with the MID&rsquo;s API key + secret: header <code>x-bharatpe-key</code>, a
            millisecond <code>x-timestamp</code> (±5 min) and <code>x-signature</code> = HMAC-SHA256 of
            <code> key.timestamp.body</code>. A live, verified credit that matches an open order confirms it and sends the
            merchant&rsquo;s success callback.
          </p>
        </div>
      </CardContent>
      {open && <ConnectDialog merchantId={merchantId} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function ConnectDialog({ merchantId, onClose }: { merchantId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [mid, setMid] = useState("");
  const [vpa, setVpa] = useState("");
  const [env, setEnv] = useState<"PROD" | "TEST">("TEST");
  const [replacePrimary, setReplacePrimary] = useState(false);
  const [askReplace, setAskReplace] = useState<string | null>(null);
  const [result, setResult] = useState<SaveResult | null>(null);

  const save = useMutation({
    mutationFn: async () =>
      readJson<SaveResult>(await fetch(`/api/merchants/${merchantId}/bharatpe`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim(), bharatpe_merchant_id: mid.trim() || undefined, payee_vpa: vpa.trim(), env, replace_primary: replacePrimary }),
      })),
    onSuccess: (r) => { setResult(r); qc.invalidateQueries({ queryKey: ["bharatpe", merchantId] }); },
    onError: (e: any) => {
      if (e?.body?.code === "PRIMARY_TAKEN") { setAskReplace(e.body.current ?? ""); return; }
      toast.error(e?.message ?? "Could not save");
    },
  });

  const canSave = label.trim().length > 0 && vpa.trim().length > 0 && (askReplace === null || replacePrimary);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{result ? "BharatPe MID created" : "Connect BharatPe"}</DialogTitle>
          <DialogDescription>
            {result ? "Save the secret now — it is shown only once." : "The BharatPe UPI ID becomes the payee; the agent gets a key + secret to report payments."}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <p className="text-sm text-[color:var(--color-warning,orange)]">
              This secret is shown once and never again. Copy it into the agent now; if it is lost, rotate the MID.
            </p>
            {result.api_key && <CopyRow label="API key" value={result.api_key} />}
            {result.secret && <CopyRow label="Secret" value={result.secret} />}
            <CopyRow label="Posts to" value={result.ingest_url} />
            <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="bp-label">Name for this MID</Label>
              <Input id="bp-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. BharatPe store 1" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bp-vpa">BharatPe UPI ID (the QR&rsquo;s UPI ID)</Label>
              <Input id="bp-vpa" value={vpa} onChange={(e) => setVpa(e.target.value)} placeholder="name@bank" autoComplete="off" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bp-mid">BharatPe merchant ID <span className={muted}>(optional)</span></Label>
              <Input id="bp-mid" value={mid} onChange={(e) => setMid(e.target.value)} placeholder="e.g. 711433303641288" inputMode="numeric" />
            </div>
            <div className="space-y-1">
              <Label>Mode</Label>
              <div className="flex gap-2">
                <Button type="button" variant={env === "TEST" ? "default" : "secondary"} size="sm" onClick={() => setEnv("TEST")}>Test</Button>
                <Button type="button" variant={env === "PROD" ? "default" : "secondary"} size="sm" onClick={() => setEnv("PROD")}>Live</Button>
              </div>
              <p className={cn("text-xs", muted)}>Live MIDs confirm real orders. Test MIDs verify the agent&rsquo;s wiring without touching live money.</p>
            </div>
            {askReplace !== null && (
              <label className="flex items-start gap-2 rounded-md border border-[color:var(--color-warning,orange)] p-2 text-sm">
                <input type="checkbox" className="mt-1" checked={replacePrimary} onChange={(e) => setReplacePrimary(e.target.checked)} />
                <span>This banker already pays to <code>{askReplace || "another UPI ID"}</code>. Make the BharatPe UPI ID the one customers pay.</span>
              </label>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button disabled={!canSave || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save"}</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
