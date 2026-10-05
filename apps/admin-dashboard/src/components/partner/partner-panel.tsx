"use client";

// One partner (lib/partner), for Katana staff (/partners/{id}) and for the partner's own login
// (/merchant-portal/sub-merchants, id "me"). What each may see and change comes from the API
// (`can`, `staff`); the screen only follows it. A partner is never shown a processor's name.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, KeyRound, Plus, RefreshCw, Webhook } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { PaymentStatus } from "@/components/portal/plain-status";
import { istTime, rupees } from "@/lib/plain-words";
import { cn } from "@/lib/utils";
import {
  actionNeedsReason, STAFF_ONLY_ACTIONS, SUB_FLOWS, SUB_STATUS_WORDS, SUB_STATUSES,
  type SubAction, type SubFlows, type SubStatus,
} from "@/lib/partner/rules";
import type { PartnerEventRow, PartnerOrderRow, PartnerRow, SubMerchantRow, SubTotals } from "@/lib/partner/store";
import type { PartnerKeyRow } from "@/lib/partner/keys";

interface Detail {
  partner: PartnerRow; staff: boolean;
  can: { settings: boolean; review: boolean; edit_subs: boolean; keys: boolean };
  flow: { flow: string; active: string | null };
  bankers: { code: string; name: string }[];
  subs: { total: number; active: number; pending: number; rejected: number; suspended: number };
  events: PartnerEventRow[];
}
type SubWithTotals = SubMerchantRow & { totals: SubTotals | null };

async function readJson<T>(r: Response): Promise<T> {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
  return d as T;
}
const send = (url: string, method: string, body?: unknown) =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(readJson);

const SUB_TONE: Record<SubStatus, "success" | "warning" | "danger" | "default"> = {
  ACTIVE: "success", PENDING: "warning", REJECTED: "danger", SUSPENDED: "danger",
};
const FLOW_WORDS: Record<SubFlows, string> = { P2P: "P2P", INTENT: "Intent", BOTH: "P2P and Intent" };
const ACTION_WORDS: Record<SubAction, string> = {
  approve: "Approve", reject: "Reject", suspend: "Suspend", reactivate: "Reactivate", resubmit: "Send for review again",
};
const selectCls = "flex h-9 w-full rounded-md border px-3 py-1 text-sm bg-[color:var(--color-surface)]";
const muted = "text-[color:var(--color-text-muted)]";

/** Staff read the v2 four; a partner reads the portal's words (lib/plain-words). */
function OrderStatus({ status, staff }: { status: string; staff: boolean }) {
  if (!staff) return <PaymentStatus status={status} />;
  const v = status === "SUCCESS" ? "SUCCESS" : status === "FAILED" ? "FAILED" : status === "EXPIRED" ? "EXPIRED" : "PENDING";
  return <Badge variant={v === "SUCCESS" ? "success" : v === "PENDING" ? "warning" : "danger"}>{v}</Badge>;
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(() => toast.success("Copied"), () => toast.error("Could not copy"));
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "warning" }) {
  return (
    <div className={cn("rounded-2xl border bg-[color:var(--color-surface)] px-3 py-2", tone === "warning" && "border-[color:var(--color-warning)]/40")}>
      <div className={cn("truncate text-xs", muted)}>{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function PartnerPanel({ partnerId }: { partnerId: string }) {
  const [tab, setTab] = useState("subs");
  const [livemode, setLivemode] = useState(true);
  const q = useQuery({ queryKey: ["partner", partnerId], queryFn: async () => readJson<Detail>(await fetch(`/api/partners/${partnerId}`)) });
  if (q.isLoading) return <p className={cn("text-sm", muted)}>Loading…</p>;
  if (q.error || !q.data) return <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error)?.message ?? "Not found"}</p>;
  const d = q.data;
  const base = `/api/partners/${partnerId}`;
  const tabs = [
    { key: "subs", label: "Sub-merchants" },
    { key: "orders", label: "Orders" },
    { key: "api", label: "API & webhook" },
    { key: "activity", label: "Activity" },
    ...(d.can.settings ? [{ key: "settings", label: "Settings" }] : []),
  ];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={d.partner.status === "ACTIVE" ? "success" : "danger"}>{d.partner.status === "ACTIVE" ? "Active" : "Suspended"}</Badge>
        <span className={cn("font-mono text-xs", muted)}>{d.partner.code}</span>
        {d.staff && d.partner.exclusive && <Badge variant="info" title="Its bankers take partner orders only">Exclusive bankers</Badge>}
        {d.staff && d.partner.auto_approve && <Badge variant="warning" title="New sub-merchants are active at once">Auto-approve</Badge>}
        {d.staff && d.partner.own_gateway && <Badge title="Partner orders never use accounts on this gateway">Own gateway: {d.partner.own_gateway}</Badge>}
        <div className="ml-auto inline-flex rounded-xl border p-0.5 text-xs" role="group" aria-label="Mode">
          {[true, false].map((m) => (
            <button key={String(m)} onClick={() => setLivemode(m)}
              className={cn("rounded-lg px-3 py-1", livemode === m ? "bg-[color:var(--color-surface-muted)] font-semibold" : muted)}>
              {m ? "Live" : "Test"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="Sub-merchants" value={d.subs.total} />
        <Stat label="Active" value={d.subs.active} />
        <Stat label="Waiting for review" value={d.subs.pending} tone={d.subs.pending ? "warning" : undefined} />
        <Stat label="Rejected / suspended" value={d.subs.rejected + d.subs.suspended} />
        <Stat label="Bankers taking payments" value={d.bankers.length} />
      </div>
      {!d.bankers.length && (
        <p className="rounded-xl border border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning-muted)] px-3 py-2 text-sm">
          {d.staff ? "This partner has no bankers yet, so its orders have nowhere to go. Add a banker under its merchant." : "Your account is not set up to take payments yet. Katana will tell you when it is."}
        </p>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto w-full justify-start overflow-x-auto">
          {tabs.map((t) => <TabsTrigger key={t.key} value={t.key} className="pb-2.5 pt-2">{t.label}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="subs"><SubsTab d={d} base={base} livemode={livemode} /></TabsContent>
        <TabsContent value="orders"><OrdersTab d={d} base={base} livemode={livemode} /></TabsContent>
        <TabsContent value="api"><ApiTab d={d} base={base} /></TabsContent>
        <TabsContent value="activity"><EventsList events={d.events} /></TabsContent>
        {d.can.settings && <TabsContent value="settings"><SettingsTab d={d} base={base} partnerId={partnerId} /></TabsContent>}
      </Tabs>
    </div>
  );
}

// ── Sub-merchants ────────────────────────────────────────────────────────────────

function SubsTab({ d, base, livemode }: { d: Detail; base: string; livemode: boolean }) {
  const [status, setStatus] = useState<string>("");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["partner-subs", base, status, search, livemode],
    queryFn: async () => readJson<{ sub_merchants: SubWithTotals[] }>(await fetch(
      `${base}/sub-merchants?mode=${livemode ? "live" : "test"}${status ? `&status=${status}` : ""}${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ""}`)),
  });
  const columns: Column<SubWithTotals>[] = [
    { key: "name", header: "Merchant", render: (s) => (
      <div><div className="font-medium">{s.display_name || s.legal_name}</div>
        <div className={cn("font-mono text-xs", muted)}>{s.external_id} · {s.sub_code}</div></div>) },
    { key: "flows", header: "Flows", render: (s) => FLOW_WORDS[s.flows] },
    { key: "status", header: "Status", render: (s) => <Badge variant={SUB_TONE[s.status]}>{SUB_STATUS_WORDS[s.status]}</Badge> },
    { key: "today", header: "Paid today", className: "text-right tabular-nums", render: (s) => s.totals ? `${rupees(s.totals.today_paid_amount)} (${s.totals.today_paid})` : "—" },
    { key: "d30", header: "Paid, 30 days", className: "text-right tabular-nums", render: (s) => s.totals ? rupees(s.totals.d30_paid_amount) : "—" },
    { key: "created", header: "Added", render: (s) => istTime(s.created_at) },
  ];
  return (
    <div className="space-y-3 pt-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-44 space-y-1">
          <Label htmlFor="sub-status">Status</Label>
          <select id="sub-status" className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {SUB_STATUSES.map((s) => <option key={s} value={s}>{SUB_STATUS_WORDS[s]}</option>)}
          </select>
        </div>
        <div className="min-w-48 flex-1 space-y-1">
          <Label htmlFor="sub-q">Search</Label>
          <Input id="sub-q" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, your id or SM_ id" />
        </div>
        {d.can.edit_subs && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add sub-merchant</Button>}
      </div>
      <Card><CardContent className="pt-6">
        {q.error ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p> : (
          <DataTable columns={columns} rows={q.data?.sub_merchants ?? []} loading={q.isLoading} rowKey={(s) => s.id}
            onRowClick={(s) => setOpen(s.id)}
            emptyState={<>No sub-merchants yet. {d.staff ? "The partner adds them through its API or portal, or add one here." : "Add one here or with the partner API (POST /api/v1/partner/merchants)."}</>} />
        )}
      </CardContent></Card>
      <SubForm open={adding} onOpenChange={setAdding} base={base} staff={d.staff} />
      <SubDrawer subId={open} onClose={() => setOpen(null)} d={d} base={base} livemode={livemode} />
    </div>
  );
}

interface SubFormValues {
  external_id: string; legal_name: string; display_name: string; business_type: string; category: string; pan: string; gstin: string;
  email: string; phone: string; website: string; address: string; flows: SubFlows; min_amount: string; max_amount: string; daily_amount: string;
}
const emptyForm: SubFormValues = {
  external_id: "", legal_name: "", display_name: "", business_type: "", category: "", pan: "", gstin: "",
  email: "", phone: "", website: "", address: "", flows: "BOTH", min_amount: "", max_amount: "", daily_amount: "",
};
const formFrom = (s: SubMerchantRow): SubFormValues => ({
  external_id: s.external_id, legal_name: s.legal_name, display_name: s.display_name ?? "", business_type: s.business_type ?? "",
  category: s.category ?? "", pan: s.pan ?? "", gstin: s.gstin ?? "", email: s.email ?? "", phone: s.phone ?? "",
  website: s.website ?? "", address: s.address ?? "", flows: s.flows,
  min_amount: s.min_amount?.toString() ?? "", max_amount: s.max_amount?.toString() ?? "", daily_amount: s.daily_amount?.toString() ?? "",
});
function bodyFrom(f: SubFormValues, editing: boolean) {
  const t = (v: string) => (v.trim() ? v.trim() : null);
  const n = (v: string) => (v.trim() ? Number(v) : null);
  return {
    ...(editing ? {} : { external_id: f.external_id.trim() }),
    legal_name: f.legal_name.trim(), display_name: t(f.display_name), business_type: t(f.business_type), category: t(f.category),
    pan: t(f.pan), gstin: t(f.gstin), email: t(f.email), phone: t(f.phone), website: t(f.website), address: t(f.address),
    flows: f.flows, min_amount: n(f.min_amount), max_amount: n(f.max_amount), daily_amount: n(f.daily_amount),
  };
}

function SubForm({ open, onOpenChange, base, staff, editing }: {
  open: boolean; onOpenChange: (v: boolean) => void; base: string; staff: boolean; editing?: SubMerchantRow;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState<SubFormValues>(editing ? formFrom(editing) : emptyForm);
  const set = (k: keyof SubFormValues, v: string) => setF((p) => ({ ...p, [k]: v }));
  const m = useMutation({
    mutationFn: () => editing
      ? send(`${base}/sub-merchants/${editing.id}`, "PATCH", bodyFrom(f, true))
      : send(`${base}/sub-merchants`, "POST", bodyFrom(f, false)),
    onSuccess: () => {
      toast.success(editing ? "Saved" : staff ? "Sub-merchant added and active" : "Sub-merchant added: Katana will review it");
      qc.invalidateQueries({ queryKey: ["partner-subs"] });
      qc.invalidateQueries({ queryKey: ["partner-sub"] });
      qc.invalidateQueries({ queryKey: ["partner"] });
      onOpenChange(false);
      if (!editing) setF(emptyForm);
    },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });
  const field = (k: keyof SubFormValues, label: string, opts: { placeholder?: string; required?: boolean; disabled?: boolean } = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={`sf-${k}`}>{label}{opts.required ? "" : <span className={muted}> (optional)</span>}</Label>
      <Input id={`sf-${k}`} value={f[k]} onChange={(e) => set(k, e.target.value)} placeholder={opts.placeholder} required={opts.required} disabled={opts.disabled} />
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit sub-merchant" : "Add a sub-merchant"}</DialogTitle>
          <DialogDescription>
            {editing ? (!staff && editing.status === "ACTIVE" ? "Changing the name, PAN or GSTIN sends it back for review." : "Changes apply to new orders.")
              : staff ? "Added by Katana staff, it is active at once." : "It can take test orders at once and live orders once Katana approves it."}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            {field("external_id", "Your id for this merchant", { required: true, placeholder: "e.g. MER-1042", disabled: !!editing })}
            {field("legal_name", "Registered business name", { required: true })}
            {field("display_name", "Name shown to customers")}
            {field("pan", "PAN", { required: !editing, placeholder: "ABCDE1234F" })}
            {field("gstin", "GSTIN")}
            {field("business_type", "Business type", { placeholder: "e.g. Private limited" })}
            {field("category", "Category", { placeholder: "e.g. Retail, Education" })}
            {field("email", "Email")}
            {field("phone", "Phone")}
            {field("website", "Website", { placeholder: "https://…" })}
          </div>
          {field("address", "Address")}
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="sf-flows">Flows</Label>
              <select id="sf-flows" className={selectCls} value={f.flows} onChange={(e) => set("flows", e.target.value)}>
                {SUB_FLOWS.map((x) => <option key={x} value={x}>{FLOW_WORDS[x]}</option>)}
              </select>
            </div>
            {field("min_amount", "Min per order (Rs)")}
            {field("max_amount", "Max per order (Rs)")}
            {field("daily_amount", "Max per day (Rs)")}
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={m.isPending || !f.legal_name.trim() || (!editing && (!f.external_id.trim() || !f.pan.trim()))}>
              {m.isPending ? "Saving…" : editing ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SubDrawer({ subId, onClose, d, base, livemode }: { subId: string | null; onClose: () => void; d: Detail; base: string; livemode: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [acting, setActing] = useState<SubAction | null>(null);
  const [reason, setReason] = useState("");
  const q = useQuery({
    queryKey: ["partner-sub", base, subId, livemode], enabled: !!subId,
    queryFn: async () => readJson<{ sub_merchant: SubMerchantRow; totals: SubTotals | null; orders: PartnerOrderRow[]; events: PartnerEventRow[] }>(
      await fetch(`${base}/sub-merchants/${subId}?mode=${livemode ? "live" : "test"}`)),
  });
  const act = useMutation({
    mutationFn: (a: SubAction) => send(`${base}/sub-merchants/${subId}`, "POST", { action: a, reason: reason.trim() || null }),
    onSuccess: () => {
      toast.success("Done");
      setActing(null); setReason("");
      qc.invalidateQueries({ queryKey: ["partner-subs"] });
      qc.invalidateQueries({ queryKey: ["partner-sub"] });
      qc.invalidateQueries({ queryKey: ["partner"] });
    },
    onError: (e: Error) => toast.error("Not done", { description: e.message }),
  });
  const s = q.data?.sub_merchant;
  const actions: SubAction[] = !s ? [] : ([
    ...(s.status === "PENDING" ? ["approve", "reject", "suspend"] : []),
    ...(s.status === "ACTIVE" ? ["suspend"] : []),
    ...(s.status === "SUSPENDED" ? ["reactivate"] : []),
    ...(s.status === "REJECTED" ? ["resubmit"] : []),
  ] as SubAction[]).filter((a) => (STAFF_ONLY_ACTIONS.includes(a) ? d.can.review : d.can.edit_subs));
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-4 border-b py-1.5 text-sm last:border-0"><span className={muted}>{label}</span><span className="text-right">{value ?? "—"}</span></div>
  );
  return (
    <Drawer open={!!subId} onOpenChange={(v) => { if (!v) { onClose(); setEditing(false); setActing(null); } }}>
      <DrawerContent size="lg">
        <DrawerHeader>
          <DrawerTitle>{s ? s.display_name || s.legal_name : "Sub-merchant"}</DrawerTitle>
          <DrawerDescription>{s ? <span className="font-mono">{s.external_id} · {s.sub_code}</span> : "Loading…"}</DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="space-y-5">
          {q.error && <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>}
          {s && (<>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={SUB_TONE[s.status]}>{SUB_STATUS_WORDS[s.status]}</Badge>
              {s.status_reason && <span className="text-sm">{s.status_reason}</span>}
              <div className="ml-auto flex flex-wrap gap-2">
                {d.can.edit_subs && <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}
                {actions.map((a) => (
                  <Button key={a} size="sm" variant={a === "reject" || a === "suspend" ? "danger" : "default"}
                    onClick={() => (actionNeedsReason(a) ? setActing(a) : act.mutate(a))} disabled={act.isPending}>
                    {ACTION_WORDS[a]}
                  </Button>
                ))}
              </div>
            </div>
            {acting && (
              <form className="space-y-2 rounded-xl border p-3" onSubmit={(e) => { e.preventDefault(); act.mutate(acting); }}>
                <Label htmlFor="sub-reason">Why? The partner is shown this.</Label>
                <Input id="sub-reason" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus required />
                <div className="flex justify-end gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => setActing(null)}>Cancel</Button>
                  <Button type="submit" size="sm" variant="danger" disabled={!reason.trim() || act.isPending}>{ACTION_WORDS[acting]}</Button>
                </div>
              </form>
            )}
            <div className="grid gap-4 sm:grid-cols-3">
              <Stat label={`Paid today (${livemode ? "live" : "test"})`} value={rupees(q.data?.totals?.today_paid_amount ?? 0)} />
              <Stat label="Orders today" value={q.data?.totals?.today_orders ?? 0} />
              <Stat label="Paid, 30 days" value={rupees(q.data?.totals?.d30_paid_amount ?? 0)} />
            </div>
            <div className="grid gap-x-8 sm:grid-cols-2">
              <div>
                {row("Registered name", s.legal_name)}
                {row("PAN", s.pan)}
                {row("GSTIN", s.gstin)}
                {row("Business type", s.business_type)}
                {row("Category", s.category)}
                {row("Website", s.website)}
              </div>
              <div>
                {row("Email", s.email)}
                {row("Phone", s.phone)}
                {row("Flows", FLOW_WORDS[s.flows])}
                {row("Per order", s.min_amount || s.max_amount ? `${s.min_amount ? rupees(s.min_amount) : "any"} to ${s.max_amount ? rupees(s.max_amount) : "any"}` : "No limit")}
                {row("Per day", s.daily_amount ? rupees(s.daily_amount) : "No limit")}
                {row("Added", `${istTime(s.created_at)} (${s.created_via.toLowerCase()})`)}
              </div>
            </div>
            {s.address && <p className="text-sm"><span className={muted}>Address: </span>{s.address}</p>}
            <div>
              <h3 className="mb-2 text-sm font-semibold">Recent orders ({livemode ? "live" : "test"})</h3>
              <OrdersTable orders={q.data?.orders ?? []} staff={d.staff} loading={q.isLoading} />
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">History</h3>
              <EventsList events={q.data?.events ?? []} />
            </div>
          </>)}
        </DrawerBody>
      </DrawerContent>
      {s && editing && <SubForm key={s.updated_at} open={editing} onOpenChange={setEditing} base={base} staff={d.staff} editing={s} />}
    </Drawer>
  );
}

// ── Orders ───────────────────────────────────────────────────────────────────────

type OrderWithSub = PartnerOrderRow & { sub_merchant?: { sub_code: string; external_id: string; name: string } | null };

function OrdersTable({ orders, staff, loading, showSub }: { orders: OrderWithSub[]; staff: boolean; loading?: boolean; showSub?: boolean }) {
  const columns: Column<OrderWithSub>[] = [
    { key: "order_id", header: "Reference", render: (o) => <span className="font-mono text-xs">{o.order_id}</span> },
    ...(showSub ? [{ key: "sub", header: "Sub-merchant", render: (o: OrderWithSub) => o.sub_merchant
      ? <span>{o.sub_merchant.name} <span className={cn("font-mono text-xs", muted)}>{o.sub_merchant.external_id}</span></span> : "—" }] : []),
    { key: "amount", header: "Amount", className: "text-right tabular-nums", render: (o) => rupees(o.amount) },
    { key: "status", header: "Status", render: (o) => <OrderStatus status={o.status} staff={staff} /> },
    { key: "channel", header: "Flow", render: (o) => o.channel_type === "INTENT" ? "Intent" : o.channel_type ?? "—" },
    ...(staff ? [{ key: "banker", header: "Banker", render: (o: OrderWithSub) => <span className="font-mono text-xs">{o.merchant_id}</span> }] : []),
    { key: "rrn", header: staff ? "RRN" : "Bank reference (UTR)", render: (o) => o.status === "SUCCESS" && o.rrn ? <span className="font-mono text-xs">{o.rrn}</span> : "—" },
    { key: "created_at", header: "Created", render: (o) => istTime(o.created_at) },
  ];
  return <DataTable columns={columns} rows={orders} loading={loading} rowKey={(o) => o.id} emptyState="No orders yet." />;
}

function OrdersTab({ d, base, livemode }: { d: Detail; base: string; livemode: boolean }) {
  const [sub, setSub] = useState("");
  const subs = useQuery({ queryKey: ["partner-subs", base, "", "", livemode], queryFn: async () => readJson<{ sub_merchants: SubWithTotals[] }>(await fetch(`${base}/sub-merchants?mode=${livemode ? "live" : "test"}`)) });
  const q = useQuery({
    queryKey: ["partner-orders", base, sub, livemode],
    queryFn: async () => readJson<{ orders: OrderWithSub[] }>(await fetch(`${base}/orders?mode=${livemode ? "live" : "test"}${sub ? `&sub=${encodeURIComponent(sub)}` : ""}&limit=200`)),
  });
  return (
    <div className="space-y-3 pt-4">
      <div className="w-72 space-y-1">
        <Label htmlFor="ord-sub">Sub-merchant</Label>
        <select id="ord-sub" className={selectCls} value={sub} onChange={(e) => setSub(e.target.value)}>
          <option value="">All</option>
          {(subs.data?.sub_merchants ?? []).map((s) => <option key={s.id} value={s.id}>{s.display_name || s.legal_name} ({s.external_id})</option>)}
        </select>
      </div>
      <Card><CardContent className="pt-6">
        {q.error ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>
          : <OrdersTable orders={q.data?.orders ?? []} staff={d.staff} loading={q.isLoading} showSub />}
      </CardContent></Card>
    </div>
  );
}

// ── API keys and webhook ─────────────────────────────────────────────────────────

interface WebhookInfo {
  url: string | null; events: "ALL" | "PAID_ONLY"; has_secret: boolean; can_manage: boolean;
  deliveries: { outbox_id: string; event_type: string; event_id: string | null; target_url: string; status: string; attempts: number; last_error: string | null; livemode: boolean; created_at: string }[];
}

function SecretOnce({ value, onDone, what }: { value: string | null; onDone: () => void; what: string }) {
  return (
    <Dialog open={!!value} onOpenChange={(v) => { if (!v) onDone(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy your {what} now</DialogTitle>
          <DialogDescription>It is shown once. Katana keeps only a fingerprint of it; if it is lost, make a new one.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-xl border bg-[color:var(--color-surface-muted)] p-3">
          <code className="flex-1 break-all text-xs">{value}</code>
          <Button size="icon" variant="ghost" onClick={() => value && copy(value)} aria-label="Copy"><Copy /></Button>
        </div>
        <DialogFooter><Button onClick={onDone}>I have copied it</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApiTab({ d, base }: { d: Detail; base: string }) {
  const qc = useQueryClient();
  const [secret, setSecret] = useState<{ value: string; what: string } | null>(null);
  const keys = useQuery({ queryKey: ["partner-keys", base], queryFn: async () => readJson<{ keys: PartnerKeyRow[]; can_manage: boolean }>(await fetch(`${base}/keys`)) });
  const hook = useQuery({ queryKey: ["partner-webhook", base], queryFn: async () => readJson<WebhookInfo>(await fetch(`${base}/webhook`)) });
  const [url, setUrl] = useState<string | null>(null);
  const issue = useMutation({
    mutationFn: (livemode: boolean) => send(`${base}/keys`, "POST", { livemode }) as Promise<{ secret: string }>,
    onSuccess: (r) => { setSecret({ value: r.secret, what: "API key" }); qc.invalidateQueries({ queryKey: ["partner-keys"] }); },
    onError: (e: Error) => toast.error("No key made", { description: e.message }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => send(`${base}/keys?key=${id}`, "DELETE"),
    onSuccess: () => { toast.success("Key revoked"); qc.invalidateQueries({ queryKey: ["partner-keys"] }); },
    onError: (e: Error) => toast.error("Not revoked", { description: e.message }),
  });
  const saveHook = useMutation({
    mutationFn: (b: { url?: string | null; events?: string }) => send(`${base}/webhook`, "PUT", b),
    onSuccess: () => { toast.success("Webhook saved"); setUrl(null); qc.invalidateQueries({ queryKey: ["partner-webhook"] }); },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });
  const rotate = useMutation({
    mutationFn: () => send(`${base}/webhook`, "POST", { rotate: true }) as Promise<{ secret: string }>,
    onSuccess: (r) => { setSecret({ value: r.secret, what: "signing secret" }); qc.invalidateQueries({ queryKey: ["partner-webhook"] }); },
    onError: (e: Error) => toast.error("No secret made", { description: e.message }),
  });
  const manage = keys.data?.can_manage ?? false;
  const keyCols: Column<PartnerKeyRow>[] = [
    { key: "prefix", header: "Key", render: (k) => <span className="font-mono text-xs">{k.prefix}…</span> },
    { key: "livemode", header: "Mode", render: (k) => <Badge variant={k.livemode ? "brand" : "default"}>{k.livemode ? "Live" : "Test"}</Badge> },
    { key: "status", header: "Status", render: (k) => <Badge variant={k.status === "ACTIVE" ? "success" : "default"}>{k.status === "ACTIVE" ? "Active" : "Revoked"}</Badge> },
    { key: "created_at", header: "Made", render: (k) => istTime(k.created_at) },
    { key: "last_used_at", header: "Last used", render: (k) => k.last_used_at ? istTime(k.last_used_at) : "Never" },
    ...(manage ? [{ key: "x", header: "", render: (k: PartnerKeyRow) => k.status === "ACTIVE"
      ? <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); revoke.mutate(k.id); }}>Revoke</Button> : null }] : []),
  ];
  const h = hook.data;
  return (
    <div className="grid gap-4 pt-4 lg:grid-cols-2">
      <Card><CardContent className="space-y-3 pt-6">
        <div className="flex items-center gap-2"><KeyRound className="h-4 w-4" /><h3 className="font-semibold">Partner API keys</h3>
          {manage && <div className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => issue.mutate(false)} disabled={issue.isPending}>New test key</Button>
            <Button size="sm" onClick={() => issue.mutate(true)} disabled={issue.isPending}>New live key</Button>
          </div>}
        </div>
        <p className={cn("text-sm", muted)}>Send as <code>Authorization: Bearer pk_…</code>. A test key makes test orders that move no money.</p>
        <DataTable columns={keyCols} rows={keys.data?.keys ?? []} loading={keys.isLoading} rowKey={(k) => k.id} emptyState="No keys yet." />
        <div className={cn("space-y-1 rounded-xl border p-3 text-xs", muted)}>
          <div className="font-mono">POST /api/v1/partner/merchants</div>
          <div className="font-mono">GET&nbsp; /api/v1/partner/merchants/&#123;id&#125;</div>
          <div className="font-mono">POST /api/v1/partner/orders</div>
          <div className="font-mono">GET&nbsp; /api/v1/partner/orders/&#123;id or reference&#125;</div>
          <a className="text-[color:var(--color-brand)] underline" href="/katana-partner-guide.html" target="_blank" rel="noreferrer">Read the partner API guide</a>
        </div>
      </CardContent></Card>

      <Card><CardContent className="space-y-3 pt-6">
        <div className="flex items-center gap-2"><Webhook className="h-4 w-4" /><h3 className="font-semibold">Webhook</h3></div>
        <p className={cn("text-sm", muted)}>Every order&apos;s result is sent here (or to the order&apos;s own callback_url), signed with your secret in <code>X-Katana-Signature</code>.</p>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); saveHook.mutate({ url: (url ?? h?.url ?? "").trim() || null }); }}>
          <Input value={url ?? h?.url ?? ""} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-server/katana/webhook" disabled={!manage} aria-label="Webhook URL" />
          {manage && <Button type="submit" disabled={saveHook.isPending || url === null}>Save</Button>}
        </form>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={h?.events === "PAID_ONLY"} disabled={!manage || !h}
              onChange={(e) => saveHook.mutate({ events: e.target.checked ? "PAID_ONLY" : "ALL" })} />
            Paid payments only
          </label>
          <span className={muted}>Signing secret: {h?.has_secret ? "set" : "not set (nothing is sent until one is made)"}</span>
          {manage && <Button size="sm" variant="secondary" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
            <RefreshCw className="h-3.5 w-3.5" /> {h?.has_secret ? "Replace secret" : "Make secret"}
          </Button>}
        </div>
        <h4 className="pt-2 text-sm font-semibold">Last deliveries</h4>
        <div className="max-h-72 space-y-1 overflow-y-auto text-xs">
          {(h?.deliveries ?? []).length === 0 && <p className={muted}>None yet.</p>}
          {(h?.deliveries ?? []).map((x) => (
            <div key={x.outbox_id} className="flex items-center gap-2 border-b py-1">
              <Badge variant={x.status === "DELIVERED" ? "success" : x.status === "PENDING" ? "warning" : "danger"}>{x.status}</Badge>
              <span className="font-mono">{x.event_type}</span>
              {!x.livemode && <Badge>Test</Badge>}
              <span className={cn("ml-auto", muted)}>{x.attempts} tries · {istTime(x.created_at)}</span>
            </div>
          ))}
        </div>
      </CardContent></Card>
      <SecretOnce value={secret?.value ?? null} what={secret?.what ?? ""} onDone={() => setSecret(null)} />
    </div>
  );
}

// ── Activity and settings ────────────────────────────────────────────────────────

const EVENT_WORDS: Record<string, string> = {
  CREATED: "Sub-merchant added", STATUS: "Status changed", UPDATED: "Details changed", PARTNER: "Partner settings changed",
  KEY_ISSUED: "API key made", KEY_REVOKED: "API key revoked", WEBHOOK: "Webhook changed", NONE_AVAILABLE: "No banker could take an order",
};

function EventsList({ events }: { events: PartnerEventRow[] }) {
  if (!events.length) return <p className={cn("pt-4 text-sm", muted)}>Nothing yet.</p>;
  return (
    <ul className="divide-y pt-2 text-sm">
      {events.map((e) => (
        <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
          <span className="font-medium">{EVENT_WORDS[e.action] ?? e.action}</span>
          {e.to_status && <span>{e.from_status ? `${SUB_STATUS_WORDS[e.from_status as SubStatus] ?? e.from_status} → ` : ""}{SUB_STATUS_WORDS[e.to_status as SubStatus] ?? e.to_status}</span>}
          {typeof e.detail?.reason === "string" && e.detail.reason && <span className={muted}>&ldquo;{e.detail.reason}&rdquo;</span>}
          <span className={cn("ml-auto text-xs", muted)}>{e.actor.replace(/^katana:/, "")} · {istTime(e.at)}</span>
        </li>
      ))}
    </ul>
  );
}

function SettingsTab({ d, base, partnerId }: { d: Detail; base: string; partnerId: string }) {
  const qc = useQueryClient();
  const p = d.partner;
  const [ownGw, setOwnGw] = useState(p.own_gateway ?? "");
  const save = useMutation({
    mutationFn: (b: Record<string, unknown>) => send(base, "PATCH", b),
    onSuccess: () => { toast.success("Saved"); qc.invalidateQueries({ queryKey: ["partner", partnerId] }); qc.invalidateQueries({ queryKey: ["partners"] }); },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });
  const toggle = (k: "exclusive" | "auto_approve", label: string, help: string) => (
    <label className="flex items-start gap-3 rounded-xl border p-3">
      <input type="checkbox" className="mt-1" checked={p[k]} onChange={(e) => save.mutate({ [k]: e.target.checked })} disabled={save.isPending} />
      <span><span className="font-medium">{label}</span><span className={cn("block text-sm", muted)}>{help}</span></span>
    </label>
  );
  return (
    <div className="grid gap-4 pt-4 lg:grid-cols-2">
      <Card><CardContent className="space-y-3 pt-6">
        <h3 className="font-semibold">Partner settings</h3>
        <div className="flex items-center gap-3 rounded-xl border p-3">
          <span className="flex-1"><span className="font-medium">Status</span>
            <span className={cn("block text-sm", muted)}>A suspended partner takes no orders and cannot make keys.</span></span>
          <Button variant={p.status === "ACTIVE" ? "danger" : "default"} size="sm" disabled={save.isPending}
            onClick={() => save.mutate({ status: p.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE" })}>
            {p.status === "ACTIVE" ? "Suspend partner" : "Reactivate partner"}
          </Button>
        </div>
        {toggle("exclusive", "Exclusive bankers", "Its bankers take the partner's orders only; their own Key + Salt and v2 keys are refused (PARTNER_ONLY).")}
        {toggle("auto_approve", "Approve new sub-merchants automatically", "Off: each one waits for Compliance before it may take live orders.")}
        <form className="space-y-1.5" onSubmit={(e) => { e.preventDefault(); save.mutate({ own_gateway: ownGw.trim() || null }); }}>
          <Label htmlFor="own-gw">The partner&apos;s own gateway</Label>
          <div className="flex gap-2">
            <Input id="own-gw" value={ownGw} onChange={(e) => setOwnGw(e.target.value.toUpperCase())} placeholder="e.g. PAYATOM" />
            <Button type="submit" variant="secondary" disabled={save.isPending}>Save</Button>
          </div>
          <p className={cn("text-xs", muted)}>Partner orders never go to a banker&apos;s account on this gateway, so money never loops back to the partner.</p>
        </form>
      </CardContent></Card>
      <Card><CardContent className="space-y-3 pt-6">
        <h3 className="font-semibold">Where the money lands</h3>
        <p className={cn("text-sm", muted)}>
          Partner orders are taken by the bankers of its merchant ({d.flow.flow === "UNSET" ? "no pay-in flow selected yet" : `pay-in flow ${d.flow.flow}`}),
          in the order of that merchant&apos;s banker switch when it is on. Settlement is banker → partner, as for any merchant.
        </p>
        <ul className="divide-y text-sm">
          {d.bankers.map((b) => <li key={b.code} className="flex justify-between py-1.5"><span>{b.name}</span><span className="font-mono text-xs">{b.code}</span></li>)}
          {!d.bankers.length && <li className={cn("py-1.5", muted)}>No bankers yet.</li>}
        </ul>
      </CardContent></Card>
    </div>
  );
}
