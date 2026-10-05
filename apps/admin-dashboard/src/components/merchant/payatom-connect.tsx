"use client";

// PayAtom for one banker, in plain words (lib/payatom-setup, /api/merchants/{id}/payatom): what
// PayAtom does here, what is still missing, and a three-step "Connect PayAtom" that asks only
// what a person knows (which PayAtom product, the details PayAtom sent, the location) and does
// the routing setup itself. Staff only (Super Admin), like every processor credential.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Circle, Copy, Plug } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LOCATION_PRESETS } from "@/lib/payatom-setup";
import { cn } from "@/lib/utils";

interface ProductState { account: "main" | "extra"; env: "PROD" | "TEST"; pid_hint: string; api_key_hint?: string; api_key_is_secret?: boolean; api_base: string | null; golive: string | null; reachable?: boolean }
interface State {
  banker: string;
  flow: { flow: string; active: string | null };
  p2p: ProductState | null;
  intent: ProductState | null;
  main_other: { gateway: string } | null;
  location: { latitude: string; longitude: string } | null;
  live_switched_on: boolean;
  payatom_needs: { whitelist_ip: string; callback_url: string };
}

type Choice = "P2P" | "INTENT" | "BOTH";
const muted = "text-[color:var(--color-text-muted)]";

const PRODUCTS = {
  P2P: { title: "UPI link (P2P)", money: "The customer pays straight into the banker's own bank account.", payatom: "PayAtom calls this: Payin P2P Seamless" },
  INTENT: { title: "Intent", money: "The customer pays PayAtom; PayAtom settles the money to the banker.", payatom: "PayAtom calls this: Payin P2C Seamless" },
} as const;

async function readJson<T>(r: Response): Promise<T> {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error ?? "HTTP " + r.status), { body: d });
  return d as T;
}
const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast.success("Copied"), () => toast.error("Could not copy"));

function statusOf(p: ProductState | null): { word: string; tone: "success" | "warning" | "info" | "default" } {
  if (!p) return { word: "Not connected", tone: "default" };
  if (p.env === "TEST") return { word: "UAT (test system)", tone: "info" };
  if (p.reachable === false) return { word: "Saved, not in use", tone: "warning" };
  if (p.golive === "VERIFYING") return { word: "Live, verifying", tone: "warning" };
  return { word: "Live", tone: "success" };
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={cn("w-40 shrink-0", muted)}>{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-[color:var(--color-surface-muted)] px-2 py-1 text-xs">{value}</code>
      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copy(value)} aria-label={`Copy ${label}`}><Copy /></Button>
    </div>
  );
}

export function PayatomConnectCard({ merchantId }: { merchantId: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ["payatom", merchantId], queryFn: async () => readJson<State>(await fetch(`/api/merchants/${merchantId}/payatom`)) });
  if (q.isLoading) return null;
  if (q.error) return null;   // not Super Admin, or no such banker: the generic card stays
  const s = q.data!;
  const connected = !!(s.p2p || s.intent);
  const flowHas = (f: "P2P" | "INTENT") => s.flow.flow === "UNSET" || s.flow.flow === "BOTH" || s.flow.flow === f;
  const warnings: string[] = [];
  if ((s.p2p?.env === "PROD" || s.intent?.env === "PROD") && !s.live_switched_on)
    warnings.push("Live PayAtom payments are not switched on on the server yet (PAYATOM in PAYIN_CONNECTORS_PROD). Until then no live order reaches PayAtom.");
  if (s.p2p && !flowHas("P2P")) warnings.push("UPI link (P2P) is connected, but this banker's pay-in flow is Intent only, so it is not used.");
  if (s.intent && !flowHas("INTENT")) warnings.push("Intent is connected, but this banker's pay-in flow is P2P only, so it is not used.");
  if (s.intent && s.intent.reachable === false) warnings.push("The Intent account is saved but not in this banker's traffic switch, so Intent orders do not reach it. Save the setup again to fix it.");
  for (const [name, p] of [["UPI link (P2P)", s.p2p], ["Intent", s.intent]] as const)
    if (p?.api_key_is_secret) warnings.push(`${name}: the saved API key is the secret key, so PayAtom refuses every payment ("Invalid API key"). Change PayAtom setup and paste PayAtom's API key (the one with dashes) in the API key box.`);
  if (s.p2p?.env === "TEST" || s.intent?.env === "TEST") warnings.push("UAT details are saved. Katana's test orders do not reach PayAtom yet, so UAT cannot be tried through Katana until PayAtom test mode is added.");

  const steps = [
    { done: connected, text: "Enter the details PayAtom sent (the Connect PayAtom button)" },
    { done: false, text: "Ask PayAtom to whitelist Katana's server and set the payment-update URL (both below)", manual: true },
    { done: !connected || (s.p2p?.env !== "PROD" && s.intent?.env !== "PROD") ? false : s.live_switched_on, text: "Live PayAtom switched on on the server" },
    { done: [s.p2p, s.intent].some((p) => p?.golive === "LIVE"), text: "First real payment confirmed (P2P / Intent tab → live test, then mark the account Live on Gateway go-live)" },
  ];

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Plug className="h-4 w-4" />
          <CardTitle className="text-base">PayAtom</CardTitle>
          <Button size="sm" className="ml-auto" onClick={() => setOpen(true)}>{connected ? "Change PayAtom setup" : "Connect PayAtom"}</Button>
        </div>
        <CardDescription>Take this banker&apos;s payments through PayAtom. Choose UPI link, Intent or both; Katana does the routing.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {(["P2P", "INTENT"] as const).map((k) => {
            const p = k === "P2P" ? s.p2p : s.intent;
            const st = statusOf(p);
            return (
              <div key={k} className="rounded-xl border p-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{PRODUCTS[k].title}</span>
                  <Badge variant={st.tone} className="ml-auto">{st.word}</Badge>
                </div>
                <p className={cn("mt-1 text-xs", muted)}>{PRODUCTS[k].money}</p>
                {p && <p className={cn("mt-1 text-xs", muted)}>PID {p.pid_hint} · API key {p.api_key_hint ?? "—"} · {p.api_base}</p>}
              </div>
            );
          })}
        </div>

        <ol className="space-y-1.5 text-sm">
          {steps.map((x, i) => (
            <li key={i} className="flex gap-2">
              {x.done ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-success)]" />
                : <Circle className={cn("mt-0.5 h-4 w-4 shrink-0", muted)} />}
              <span className={x.done ? "" : muted}>{x.text}{x.manual ? " (Katana cannot check this)" : ""}</span>
            </li>
          ))}
        </ol>

        <div className="space-y-1.5 rounded-xl border p-3">
          <div className="text-sm font-medium">Send these to PayAtom</div>
          <CopyRow label="Server IP to whitelist" value={s.payatom_needs.whitelist_ip} />
          <CopyRow label="Callback URL" value={s.payatom_needs.callback_url} />
        </div>

        {warnings.map((w) => (
          <p key={w} className="flex gap-2 rounded-xl border border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning-muted)] px-3 py-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-warning)]" />{w}
          </p>
        ))}
      </CardContent>
      {open && <ConnectDialog merchantId={merchantId} state={s} onClose={() => setOpen(false)} />}
    </Card>
  );
}

interface CredForm { pid: string; secret: string; api_key: string; api_base: string }
const emptyCreds: CredForm = { pid: "", secret: "", api_key: "", api_base: "" };

function ConnectDialog({ merchantId, state, onClose }: { merchantId: string; state: State; onClose: () => void }) {
  const qc = useQueryClient();
  const [step, setStep] = useState(1);
  const [choice, setChoice] = useState<Choice>(state.p2p && state.intent ? "BOTH" : state.intent ? "INTENT" : "P2P");
  const [env, setEnv] = useState<"PROD" | "TEST">((state.p2p ?? state.intent)?.env ?? "PROD");
  const [p2p, setP2p] = useState<CredForm>({ ...emptyCreds, api_base: state.p2p?.api_base ?? "" });
  const [intent, setIntent] = useState<CredForm>({ ...emptyCreds, api_base: state.intent?.api_base ?? "" });
  const [same, setSame] = useState(true);
  const [lat, setLat] = useState(state.location?.latitude ?? "");
  const [lng, setLng] = useState(state.location?.longitude ?? "");
  const [replace, setReplace] = useState(false);
  const [taken, setTaken] = useState<string | null>(null);
  const wantP2p = choice !== "INTENT", wantIntent = choice !== "P2P";
  const both = wantP2p && wantIntent;

  const save = useMutation({
    mutationFn: async () => readJson(await fetch(`/api/merchants/${merchantId}/payatom`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        want: { p2p: wantP2p, intent: wantIntent }, env, latitude: lat, longitude: lng, replace_main: replace,
        ...(wantP2p ? { p2p } : {}),
        ...(wantIntent ? { intent: both && same ? { ...intent, api_key: intent.api_key || p2p.api_key, api_base: intent.api_base || p2p.api_base } : intent } : {}),
      }),
    })),
    onSuccess: () => {
      toast.success("PayAtom saved", { description: "Next: send PayAtom the server IP and callback URL, then make a test payment." });
      qc.invalidateQueries({ queryKey: ["payatom", merchantId] });
      qc.invalidateQueries({ queryKey: ["merchant", merchantId] });
      onClose();
    },
    onError: (e: Error & { body?: { code?: string } }) => {
      if (e.body?.code === "MAIN_TAKEN") { setTaken(e.message); setStep(3); return; }
      toast.error("Not saved", { description: e.message });
    },
  });

  const savedHint = (p: ProductState | null) => (p ? `saved ${p.pid_hint}: leave blank to keep` : "");
  const credFields = (who: "P2P" | "INTENT", f: CredForm, set: (f: CredForm) => void, shareFromFirst: boolean) => {
    const saved = who === "P2P" ? state.p2p : state.intent;
    const field = (k: keyof CredForm, label: string, placeholder: string, secret = false) => (
      <div className="space-y-1">
        <Label htmlFor={`pa-${who}-${k}`}>{label}</Label>
        {/* Never the browser's saved sign-in: a password manager filled these with a site login. */}
        <Input id={`pa-${who}-${k}`} name={`payatom-${who}-${k}`} type={secret ? "password" : "text"}
          autoComplete={secret ? "new-password" : "off"} data-lpignore="true" data-1p-ignore="true" data-form-type="other" value={f[k]}
          onChange={(e) => set({ ...f, [k]: e.target.value })} placeholder={saved && k !== "api_base" ? "leave blank to keep the saved one" : placeholder} />
      </div>
    );
    return (
      <div className="space-y-2 rounded-xl border p-3">
        <div className="text-sm font-medium">{PRODUCTS[who].title} <span className={cn("font-normal", muted)}>· {PRODUCTS[who].payatom}</span></div>
        {saved && <p className={cn("text-xs", muted)}>{savedHint(saved)}</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {field("pid", "PID", "PID from PayAtom")}
          {field("secret", "Secret key", "secret key from PayAtom", true)}
          {!shareFromFirst && field("api_key", "API key", "X-Api-Key from PayAtom", true)}
          {!shareFromFirst && field("api_base", "Base URL", env === "PROD" ? "https://… (live)" : "https://… (UAT)")}
        </div>
      </div>
    );
  };

  const canNext1 = true;
  const needsNew = (p: ProductState | null, f: CredForm) => !p && (!f.pid.trim() || !f.secret.trim());
  const needsShared = (p: ProductState | null, f: CredForm) => !p && (!f.api_key.trim() || !f.api_base.trim());
  // The same value in both boxes is a paste slip (PayAtom then answers "Invalid API key").
  const sameKey = (f: CredForm) => !!f.api_key.trim() && f.api_key.trim() === f.secret.trim();
  const keyMixup = (wantP2p && sameKey(p2p)) || (wantIntent && sameKey(intent));
  const canNext2 = !keyMixup && !!lat.trim() && !!lng.trim()
    && !(wantP2p && (needsNew(state.p2p, p2p) || needsShared(state.p2p, p2p)))
    && !(wantIntent && (needsNew(state.intent, intent) || (!(both && same) && needsShared(state.intent, intent))));

  const summary: string[] = [];
  if (wantP2p) summary.push(`UPI link (P2P) orders go to PayAtom; the money lands in the banker's own account.`);
  if (wantIntent) summary.push(`Intent orders go to PayAtom; PayAtom settles to the banker.`);
  summary.push(env === "PROD" ? "Live: real payments. The first ones are small verification payments until the account is marked Live." : "UAT: PayAtom's test system (saved for testing; Katana test orders do not use it yet).");
  if (state.main_other) summary.push(`${state.main_other.gateway} is this banker's processor today${replace ? " and will be replaced" : ""}.`);

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect PayAtom · step {step} of 3</DialogTitle>
          <DialogDescription>
            {step === 1 ? "What should PayAtom do for this banker?" : step === 2 ? "The details PayAtom sent you." : "Check and save."}
          </DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-3">
            {(["P2P", "INTENT", "BOTH"] as const).map((c) => (
              <button key={c} type="button" onClick={() => setChoice(c)}
                className={cn("w-full rounded-xl border p-3 text-left", choice === c && "border-[color:var(--color-brand)] ring-2 ring-[color:var(--color-brand)]/30")}>
                <div className="font-medium">{c === "BOTH" ? "Both" : PRODUCTS[c].title}</div>
                <div className={cn("text-sm", muted)}>{c === "BOTH" ? "UPI link and Intent: each order takes the flow it asks for." : PRODUCTS[c].money}</div>
                {c !== "BOTH" && <div className={cn("text-xs", muted)}>{PRODUCTS[c].payatom}</div>}
              </button>
            ))}
            <div className="flex flex-wrap items-center gap-3 pt-1 text-sm">
              <span className="font-medium">Which PayAtom system?</span>
              {(["PROD", "TEST"] as const).map((e) => (
                <label key={e} className="inline-flex items-center gap-1.5">
                  <input type="radio" checked={env === e} onChange={() => setEnv(e)} />{e === "PROD" ? "Live" : "UAT (test)"}
                </label>
              ))}
            </div>
            {env === "PROD" && !state.live_switched_on && (
              <p className="rounded-xl border border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning-muted)] px-3 py-2 text-sm">
                Live PayAtom is not switched on on the server yet, so live details cannot be saved. Ask ops to add PAYATOM to PAYIN_CONNECTORS_PROD.
              </p>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            {wantP2p && credFields("P2P", p2p, setP2p, false)}
            {both && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} />
                PayAtom gave the same API key and base URL for both
              </label>
            )}
            {wantIntent && credFields("INTENT", intent, setIntent, both && same)}
            {keyMixup && (
              <p className="rounded-xl border border-[color:var(--color-danger)]/40 bg-[color:var(--color-danger-muted)] px-3 py-2 text-sm text-[color:var(--color-danger)]">
                The API key and the secret key are the same. They are two different values from PayAtom: the API key is the one with dashes.
              </p>
            )}
            <div className="space-y-2 rounded-xl border p-3">
              <div className="text-sm font-medium">Location PayAtom registered <span className={cn("font-normal", muted)}>· sent with every payment</span></div>
              <div className="flex flex-wrap gap-1.5">
                {LOCATION_PRESETS.map((l) => (
                  <Button key={l.name} type="button" size="sm" variant="secondary" onClick={() => { setLat(l.latitude); setLng(l.longitude); }}>{l.name}</Button>
                ))}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1"><Label htmlFor="pa-lat">Latitude</Label><Input id="pa-lat" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="19.0760" /></div>
                <div className="space-y-1"><Label htmlFor="pa-lng">Longitude</Label><Input id="pa-lng" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="72.8777" /></div>
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <ul className="list-disc space-y-1 pl-5 text-sm">{summary.map((x) => <li key={x}>{x}</li>)}</ul>
            {(state.main_other || taken) && (
              <label className="flex items-start gap-2 rounded-xl border border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning-muted)] p-3 text-sm">
                <input type="checkbox" className="mt-1" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                <span>{taken ?? `${state.main_other!.gateway} takes this banker's payments today.`} Tick to replace it with PayAtom. Orders already open keep using the old one.</span>
              </label>
            )}
            <div className="rounded-xl border p-3 text-sm">
              <div className="font-medium">After saving, send PayAtom:</div>
              <div className={muted}>Server IP to whitelist: <code>{state.payatom_needs.whitelist_ip}</code></div>
              <div className={muted}>Callback URL: <code>{state.payatom_needs.callback_url}</code></div>
            </div>
          </div>
        )}

        <DialogFooter>
          {step > 1 && <Button variant="secondary" onClick={() => setStep(step - 1)}>Back</Button>}
          {step < 3 && <Button onClick={() => setStep(step + 1)}
            disabled={step === 1 ? !canNext1 || (env === "PROD" && !state.live_switched_on) : !canNext2}>Next</Button>}
          {step === 3 && <Button onClick={() => save.mutate()} disabled={save.isPending || (!!(state.main_other || taken) && !replace)}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
