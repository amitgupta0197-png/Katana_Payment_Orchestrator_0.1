"use client";

// DT Purchases (BRD §10). List + create draft + drive the lifecycle:
// DRAFT → PENDING_APPROVAL → AWAITING_FUNDS → FUNDS_SUBMITTED → ACTIVE (60/40 split
// materialised on confirm). Admin/Finance-gated.

import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Receipt, Plus, Send, ShieldCheck, Banknote, CheckCircle2, XCircle, KeyRound, Copy, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { DataView } from "@/components/world-class/data-view";
import { RowActions } from "@/components/world-class/row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { Column } from "@/components/ui/data-table";
import { formatAmount, formatDateTime } from "@/lib/utils";

interface Purchase {
  id: string; banker_id: string; quantity: number; buy_rate: number; total_amount: number;
  priority_percent: number; security_percent: number; status: string; payment_ref: string; created_at: string;
}

const STATUS_VARIANT: Record<string, "default" | "info" | "warning" | "success" | "danger"> = {
  DRAFT: "default", PENDING_APPROVAL: "info", AWAITING_FUNDS: "warning", FUNDS_SUBMITTED: "info",
  ACTIVE: "success", EXHAUSTED: "warning", SUSPENDED: "warning", REFILLED: "success", CLOSED: "default", REJECTED: "danger",
};

interface LedgerLot {
  id: string; quantity: number; buy_rate: number; total_amount: number; status: string;
  payment_ref: string; created_at: string;
  quota_allocated: number; quota_reserved: number; quota_consumed: number; quota_available: number;
  reserve_held: number; reserve_dt: number; reserve_released: number; reserve_status: string;
}
interface Wallet { traffic: { allocated: number; reserved: number; consumed: number; available: number; utilization: number }; ledger: LedgerLot[] }

export default function DtPurchasesPage() {
  const qc = useQueryClient();
  // ?banker=X → single-banker drill-down: list filtered + full ledger card on top.
  const banker = useSearchParams().get("banker");
  const q = useQuery({
    queryKey: ["dt-purchases", banker],
    queryFn: async () => {
      const r = await fetch(`/api/v1/dt/purchases${banker ? `?banker=${encodeURIComponent(banker)}` : ""}`);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d.purchases as Purchase[];
    },
  });
  const ledgerQ = useQuery({
    queryKey: ["dt-banker-ledger", banker],
    enabled: !!banker,
    queryFn: async () => {
      const r = await fetch(`/api/v1/dt/wallets/${encodeURIComponent(banker!)}`);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as Wallet;
    },
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ banker_id: "", quantity: "", buy_rate: "" });
  // Optionally provision the banker's sign-in together with their first purchase —
  // a purchase row alone never creates a login.
  const [withNewLogin, setWithNewLogin] = useState(false);
  const [newLoginEmail, setNewLoginEmail] = useState("");
  const create = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { banker_id: form.banker_id.trim(), quantity: Number(form.quantity) };
      if (form.buy_rate.trim()) body.buy_rate = Number(form.buy_rate);
      const r = await fetch("/api/v1/dt/purchases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      // Purchase created — provision the login if requested (surface its own error).
      if (withNewLogin && newLoginEmail.trim()) {
        const lr = await fetch("/api/v1/dt/bankers", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ banker_id: form.banker_id.trim(), email: newLoginEmail.trim() }),
        });
        const ld = await lr.json().catch(() => ({}));
        if (!lr.ok) throw new Error(`purchase created, but banker login failed: ${ld.error ?? "unknown error"}`);
        return ld.login as { email: string; password: string | null; existing: boolean };
      }
      return null;
    },
    onSuccess: (login) => {
      toast.success("Draft purchase created");
      setCreateOpen(false);
      setForm({ banker_id: "", quantity: "", buy_rate: "" });
      setWithNewLogin(false); setNewLoginEmail("");
      qc.invalidateQueries({ queryKey: ["dt-purchases"] });
      // Show the one-time credentials in the Banker-login dialog panel.
      if (login) { setIssued(login); setResetMode(false); setLoginOpen(true); }
    },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const transition = useMutation({
    mutationFn: async ({ id, to, reference_no }: { id: string; to: string; reference_no?: string }) => {
      const r = await fetch(`/api/v1/dt/purchases/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, reference_no }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
    },
    onSuccess: () => { toast.success("Purchase updated"); qc.invalidateQueries({ queryKey: ["dt-purchases"] }); },
    onError: (e: Error) => toast.error("Transition failed", { description: e.message }),
  });

  // confirm-funds needs a reference number → small dialog
  const [fundsFor, setFundsFor] = useState<Purchase | null>(null);
  const [fundsRef, setFundsRef] = useState("");

  // Separate banker login (BANKER persona → /banker-portal). One-time password shown once.
  // Reset mode issues a fresh one-time password for an existing banker (forgot password).
  const [loginOpen, setLoginOpen] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [loginForm, setLoginForm] = useState({ banker_id: "", email: "", full_name: "" });
  const [issued, setIssued] = useState<{ email: string; password: string | null; existing: boolean; reset?: boolean } | null>(null);
  const createLogin = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = resetMode
        ? { reset_password: true, email: loginForm.email.trim() }
        : { banker_id: loginForm.banker_id.trim(), email: loginForm.email.trim() };
      if (!resetMode && loginForm.full_name.trim()) body.full_name = loginForm.full_name.trim();
      const r = await fetch("/api/v1/dt/bankers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return { ...(d.login as { email: string; password: string | null; existing: boolean }), reset: !!d.reset };
    },
    onSuccess: (login) => { setIssued(login); toast.success(login.reset ? "Password reset" : "Banker login ready"); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const cols: Column<Purchase>[] = [
    { key: "banker_id", header: "Banker", render: (r) => <span className="font-medium">{r.banker_id}</span> },
    { key: "quantity", header: "DT Qty", render: (r) => r.quantity.toLocaleString("en-IN") },
    { key: "buy_rate", header: "Rate", render: (r) => formatAmount(r.buy_rate) },
    { key: "total_amount", header: "Advance", render: (r) => <span className="font-medium">{formatAmount(r.total_amount)}</span> },
    { key: "split", header: "Split", render: (r) => `${r.priority_percent}/${r.security_percent}` },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status] ?? "default"}>{r.status}</Badge> },
    { key: "created_at", header: "Created", render: (r) => formatDateTime(r.created_at) },
  ];

  function actionsFor(r: Purchase) {
    const a: { label: string; icon: any; onClick: () => void; variant?: "danger" }[] = [];
    if (r.status === "DRAFT") a.push({ label: "Submit for approval", icon: Send, onClick: () => transition.mutate({ id: r.id, to: "PENDING_APPROVAL" }) });
    if (r.status === "PENDING_APPROVAL") a.push({ label: "Approve", icon: ShieldCheck, onClick: () => transition.mutate({ id: r.id, to: "AWAITING_FUNDS" }) });
    if (r.status === "AWAITING_FUNDS") a.push({ label: "Mark funds submitted", icon: Banknote, onClick: () => transition.mutate({ id: r.id, to: "FUNDS_SUBMITTED" }) });
    if (r.status === "FUNDS_SUBMITTED") a.push({ label: "Confirm funds → activate", icon: CheckCircle2, onClick: () => { setFundsFor(r); setFundsRef(""); } });
    if (["DRAFT", "PENDING_APPROVAL", "AWAITING_FUNDS", "FUNDS_SUBMITTED"].includes(r.status))
      a.push({ label: "Reject", icon: XCircle, variant: "danger", onClick: () => { if (confirm(`Reject purchase for ${r.banker_id}?`)) transition.mutate({ id: r.id, to: "REJECTED" }); } });
    return a;
  }

  return (
    <>
      <PageHeader
        title={banker ? `DT Purchases — ${banker}` : "DT Purchases"}
        description={banker ? `Full ledger and purchase lifecycle for ${banker}.` : "Banker advance purchases and their approval/funding lifecycle (BRD §10)."}
        icon={Receipt}
        actions={
          <div className="flex items-center gap-2">
            {banker && (
              <Link href="/dt-purchases" className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]">
                <X className="h-4 w-4" /> All bankers
              </Link>
            )}
            <Button variant="secondary" onClick={() => { setIssued(null); setResetMode(false); setLoginForm({ banker_id: "", email: "", full_name: "" }); setLoginOpen(true); }}>
              <KeyRound className="h-4 w-4" /> Banker login
            </Button>
          </div>
        }
      />

      {/* Single-banker ledger — the full break-up of every lot's quota + reserve */}
      {banker && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Ledger — {banker}</CardTitle>
            <CardDescription>
              Every lot's advance, 60% quota position and 40% rolling reserve. Reserves released by refill rotation stay visible here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {ledgerQ.isLoading ? (
              <p className="text-sm text-[color:var(--color-text-muted)]">Loading ledger…</p>
            ) : !ledgerQ.data?.ledger?.length ? (
              <p className="text-sm text-[color:var(--color-text-muted)]">No lots yet for this banker.</p>
            ) : (
              <>
                {ledgerQ.data.traffic && (
                  <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    <span>Quota <b>{formatAmount(ledgerQ.data.traffic.allocated)}</b></span>
                    <span>Consumed <b>{formatAmount(ledgerQ.data.traffic.consumed)}</b></span>
                    <span>Available <b>{formatAmount(ledgerQ.data.traffic.available)}</b></span>
                    <span>Rolling reserve <b>{formatAmount(ledgerQ.data.ledger.reduce((s, l) => s + (l.reserve_status === "HELD" ? l.reserve_held : 0), 0))}</b>
                      <span className="ml-1 text-xs text-[color:var(--color-text-muted)]">({ledgerQ.data.ledger.reduce((s, l) => s + (l.reserve_status === "HELD" ? l.reserve_dt : 0), 0).toLocaleString("en-IN")} DT)</span></span>
                    <span>Reserve released <b>{formatAmount(ledgerQ.data.ledger.reduce((s, l) => s + l.reserve_released, 0))}</b></span>
                  </div>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-[color:var(--color-text-muted)]">
                        <th className="py-2 pr-4 font-medium">Lot</th>
                        <th className="py-2 pr-4 font-medium">DT Qty</th>
                        <th className="py-2 pr-4 font-medium">Advance</th>
                        <th className="py-2 pr-4 font-medium">Quota</th>
                        <th className="py-2 pr-4 font-medium">Consumed</th>
                        <th className="py-2 pr-4 font-medium">Available</th>
                        <th className="py-2 pr-4 font-medium">Rolling reserve</th>
                        <th className="py-2 pr-4 font-medium">Reserve status</th>
                        <th className="py-2 font-medium">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledgerQ.data.ledger.map((l) => (
                        <tr key={l.id} className="border-b last:border-0">
                          <td className="py-2 pr-4">
                            <div className="flex flex-col">
                              <Badge variant={STATUS_VARIANT[l.status] ?? "default"} className="w-fit">{l.status}</Badge>
                              {l.payment_ref.startsWith("REFILL:") && <span className="text-[10px] text-[color:var(--color-text-muted)]">from refill</span>}
                            </div>
                          </td>
                          <td className="py-2 pr-4">{l.quantity.toLocaleString("en-IN")}</td>
                          <td className="py-2 pr-4 font-medium">{formatAmount(l.total_amount)}</td>
                          <td className="py-2 pr-4">{formatAmount(l.quota_allocated)}</td>
                          <td className="py-2 pr-4">{formatAmount(l.quota_consumed)}</td>
                          <td className="py-2 pr-4">{formatAmount(l.quota_available)}</td>
                          <td className="py-2 pr-4">
                            {l.reserve_status === "RELEASED"
                              ? <span className="text-[color:var(--color-text-muted)] line-through">{formatAmount(l.reserve_held)}</span>
                              : <span className="font-medium">{formatAmount(l.reserve_held)}</span>}
                            {l.reserve_status === "HELD" && <span className="ml-1 text-xs text-[color:var(--color-text-muted)]">({l.reserve_dt.toLocaleString("en-IN")} DT)</span>}
                          </td>
                          <td className="py-2 pr-4">
                            {l.reserve_status
                              ? <Badge variant={l.reserve_status === "HELD" ? "info" : l.reserve_status === "RELEASED" ? "default" : "warning"}>{l.reserve_status}</Badge>
                              : <span className="text-[color:var(--color-text-muted)]">—</span>}
                          </td>
                          <td className="py-2">{formatDateTime(l.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
      <DataView
        rows={q.data ?? []}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        search={{ placeholder: "Search by banker…", fields: ["banker_id", "status"] }}
        filters={[
          { key: "draft", label: "Draft", predicate: (r) => r.status === "DRAFT" },
          { key: "approval", label: "Pending approval", predicate: (r) => r.status === "PENDING_APPROVAL" },
          { key: "awaiting", label: "Awaiting funds", predicate: (r) => r.status === "AWAITING_FUNDS" || r.status === "FUNDS_SUBMITTED" },
          { key: "active", label: "Active", predicate: (r) => r.status === "ACTIVE" },
        ]}
        fab={{ label: "New purchase", icon: Plus, onClick: () => setCreateOpen(true) }}
        refresh={() => q.refetch()}
        emptyTitle="No DT purchases yet"
        emptyDescription="Create a banker's first advance purchase to allocate priority traffic."
        rowActions={(r) => <RowActions actions={actionsFor(r)} />}
      />

      {/* Create draft */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New DT purchase</DialogTitle>
            <DialogDescription>Advance debit = quantity × rate. Splits 60% priority traffic / 40% rolling reserve.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5"><Label>Banker (provider code/id)</Label><Input value={form.banker_id} onChange={(e) => setForm({ ...form, banker_id: e.target.value })} placeholder="e.g. BNK-001" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>DT quantity</Label><Input type="number" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="4000" /></div>
              <div className="space-y-1.5"><Label>Buy rate <span className="text-[color:var(--color-text-subtle)]">(blank = current)</span></Label><Input type="number" step="0.01" value={form.buy_rate} onChange={(e) => setForm({ ...form, buy_rate: e.target.value })} placeholder="104.00" /></div>
            </div>
            {form.quantity && form.buy_rate && <p className="text-xs text-[color:var(--color-text-muted)]">Advance debit: <b>{formatAmount(Number(form.quantity) * Number(form.buy_rate))}</b></p>}
            <div className="space-y-2 rounded-md border p-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={withNewLogin} onChange={(e) => setWithNewLogin(e.target.checked)} />
                Also create the banker&rsquo;s login for this id
              </label>
              {withNewLogin && (
                <div className="space-y-1.5 pl-6">
                  <Label>Banker email</Label>
                  <Input type="email" value={newLoginEmail} onChange={(e) => setNewLoginEmail(e.target.value)} placeholder="banker@example.com" />
                  <p className="text-xs text-[color:var(--color-text-subtle)]">A one-time password will be shown after creation.</p>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={!form.banker_id || !form.quantity || (withNewLogin && !newLoginEmail.trim()) || create.isPending}>{create.isPending ? "Creating…" : "Create draft"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Provision a separate banker login */}
      <Dialog open={loginOpen} onOpenChange={(o) => { setLoginOpen(o); if (!o) setIssued(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Banker login</DialogTitle>
            <DialogDescription>
              {resetMode
                ? "Generates a fresh one-time password for an existing banker (the old password stops working)."
                : "Creates a separate sign-in for the banker (BANKER role, scoped to their banker id). They land in the banker portal."}
            </DialogDescription>
          </DialogHeader>
          {!issued && (
            <div className="flex gap-1 rounded-md border p-1 text-sm">
              <button
                type="button"
                onClick={() => setResetMode(false)}
                className={`flex-1 rounded px-3 py-1.5 font-medium transition-colors ${!resetMode ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]" : "text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]"}`}
              >
                Create login
              </button>
              <button
                type="button"
                onClick={() => setResetMode(true)}
                className={`flex-1 rounded px-3 py-1.5 font-medium transition-colors ${resetMode ? "bg-[color:var(--color-brand-muted)] text-[color:var(--color-brand)]" : "text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text)]"}`}
              >
                Reset password
              </button>
            </div>
          )}
          {issued ? (
            <div className="space-y-3">
              <p className="text-sm text-[color:var(--color-text-muted)]">
                {issued.reset
                  ? "Password reset. Share the new one-time password with the banker now — it is shown only once and the old password no longer works."
                  : issued.existing
                    ? "This email already had an account — the banker role was granted. They sign in with their existing password (use Reset password if it's forgotten)."
                    : "Share these credentials with the banker now — the password is shown only once."}
              </p>
              <div className="rounded-md border bg-[color:var(--color-surface-muted)] p-3 text-sm space-y-1">
                <div><span className="text-[color:var(--color-text-muted)]">Email:</span> <b>{issued.email}</b></div>
                {issued.password && <div><span className="text-[color:var(--color-text-muted)]">One-time password:</span> <b className="font-mono">{issued.password}</b></div>}
                <div><span className="text-[color:var(--color-text-muted)]">Sign-in:</span> /login → lands on /banker-portal</div>
              </div>
              {issued.password && (
                <Button variant="secondary" size="sm" onClick={() => { navigator.clipboard.writeText(`Email: ${issued.email}\nPassword: ${issued.password}\nLogin: /login`); toast.success("Copied"); }}>
                  <Copy className="h-4 w-4" /> Copy credentials
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {!resetMode && <div className="space-y-1.5"><Label>Banker id (matches purchases)</Label><Input value={loginForm.banker_id} onChange={(e) => setLoginForm({ ...loginForm, banker_id: e.target.value })} placeholder="e.g. BNK-001" /></div>}
              <div className="space-y-1.5"><Label>Email</Label><Input type="email" value={loginForm.email} onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })} placeholder="banker@example.com" /></div>
              {!resetMode && <div className="space-y-1.5"><Label>Full name <span className="text-[color:var(--color-text-subtle)]">(optional)</span></Label><Input value={loginForm.full_name} onChange={(e) => setLoginForm({ ...loginForm, full_name: e.target.value })} /></div>}
            </div>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => { setLoginOpen(false); setIssued(null); }}>{issued ? "Done" : "Cancel"}</Button>
            {!issued && (
              <Button onClick={() => createLogin.mutate()} disabled={(!resetMode && !loginForm.banker_id.trim()) || !loginForm.email.trim() || createLogin.isPending}>
                {createLogin.isPending ? (resetMode ? "Resetting…" : "Creating…") : (resetMode ? "Reset password" : "Create login")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm funds */}
      <Dialog open={!!fundsFor} onOpenChange={(o) => !o && setFundsFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm funds & activate</DialogTitle>
            <DialogDescription>Records the funding reference and materialises the 60% traffic quota + 40% rolling reserve.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-[color:var(--color-text-muted)]">{fundsFor?.banker_id} · advance <b>{fundsFor ? formatAmount(fundsFor.total_amount) : ""}</b></p>
            <div className="space-y-1.5"><Label>Bank reference number</Label><Input value={fundsRef} onChange={(e) => setFundsRef(e.target.value)} placeholder="UTR / payment ref" /></div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setFundsFor(null)}>Cancel</Button>
            <Button disabled={!fundsRef.trim() || transition.isPending} onClick={() => { if (fundsFor) transition.mutate({ id: fundsFor.id, to: "ACTIVE", reference_no: fundsRef.trim() }, { onSuccess: () => setFundsFor(null) }); }}>Confirm & activate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
