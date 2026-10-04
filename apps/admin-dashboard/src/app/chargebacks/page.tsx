"use client";

// Banker-side chargebacks (lib/chargebacks-store), for staff: record what the bank, acquirer or
// gateway reported, see each one matched to its original pay-in inside that pay-in's channel, and
// decide the ones the rules could not: link by hand, approve a debit, reverse one, dismiss a record
// that is not a chargeback. The Rules tab sets what share of a chargeback is debited, per merchant,
// banker, channel and reason; with no rule nothing is ever debited.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ChargebacksList } from "@/components/chargebacks/chargebacks-list";
import { ChannelBadge } from "@/components/payin/channel";
import { formatAmount, formatDateTime } from "@/lib/utils";
import { CB_OPEN, CB_SOURCES, REVERSAL_KINDS } from "@/lib/chargeback-rules";
import type { StaffChargeback } from "@/lib/chargeback-view";

const send = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d;
};
const sel = "w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm";

export default function StaffChargebacksPage() {
  const [recordOpen, setRecordOpen] = useState(false);
  return (
    <>
      <PageHeader
        title="Chargebacks"
        description="Banker-side chargebacks on Katana Pay pay-ins: matched to the original pay-in in its channel, ruled on, debited and reversed."
        icon={ShieldAlert}
        actions={<Button size="sm" onClick={() => setRecordOpen(true)}><Plus className="h-4 w-4" /> Record chargebacks</Button>}
      />
      <Tabs defaultValue="list">
        <TabsList className="mb-4">
          <TabsTrigger value="list">Chargebacks</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
        </TabsList>
        <TabsContent value="list">
          <ChargebacksList staff renderActions={(r, refresh) => <StaffDetail row={r} refresh={refresh} />} />
        </TabsContent>
        <TabsContent value="rules"><Rules /></TabsContent>
      </Tabs>
      <RecordDialog open={recordOpen} onOpenChange={setRecordOpen} />
    </>
  );
}

// ── One chargeback: what was reported, the chain, and what a person can do ─────────────────────

function StaffDetail({ row, refresh }: { row: StaffChargeback; refresh: () => void }) {
  const qc = useQueryClient();
  const chain = useQuery({
    queryKey: ["chargeback", row.id],
    queryFn: async () => (await fetch(`/api/chargebacks/${row.id}`).then((r) => r.json())) as {
      postings: { id: string; kind: string; amount: number; rule_version: number | null; debit_bps: number | null; basis: Record<string, unknown>; actor: string; note: string | null; created_at: string; reverses_id: string | null }[];
      events: { from_state: string | null; to_state: string; actor: string | null; note: string | null; at: string }[];
    },
  });
  const [order, setOrder] = useState("");
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState<(typeof REVERSAL_KINDS)[number]>("REPRESENTMENT_WON");
  const act = useMutation({
    mutationFn: (body: Record<string, unknown>) => send(`/api/chargebacks/${row.id}`, body),
    onSuccess: (d: { chargeback: StaffChargeback }) => {
      toast.success(`${d.chargeback.cb_ref}: ${d.chargeback.state}`, { description: d.chargeback.state_note ?? undefined });
      setNote(""); setAmount(""); setOrder("");
      qc.invalidateQueries({ queryKey: ["chargeback", row.id] }); refresh();
    },
    onError: (e: Error) => toast.error("Not done", { description: e.message }),
  });
  const open = CB_OPEN.includes(row.state);
  const canReverse = row.debited - row.reversed > 0.005;
  const amt = amount.trim() === "" ? null : Number(amount);

  return (
    <div className="grid grid-cols-1 gap-4 text-sm lg:grid-cols-2">
      <div className="space-y-2">
        <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1">
          <dt className="text-[color:var(--color-text-muted)]">Reference</dt><dd className="font-mono">{row.cb_ref}</dd>
          <dt className="text-[color:var(--color-text-muted)]">Reported by</dt><dd>{row.source_raw}{row.source_name ? ` · ${row.source_name}` : ""}</dd>
          <dt className="text-[color:var(--color-text-muted)]">As reported</dt>
          <dd className="text-xs">order {row.stated_order ?? "—"} · banker {row.stated_banker ?? "—"} · channel {row.stated_channel ?? "—"}{row.event_date ? ` · ${row.event_date}` : ""}</dd>
          <dt className="text-[color:var(--color-text-muted)]">Matched</dt>
          <dd className="text-xs">{row.order_id ? `${row.match_method?.toLowerCase().replace("_", " ")} by ${row.matched_by ?? "—"}${row.matched_at ? ` · ${formatDateTime(row.matched_at)}` : ""}` : "not yet"}</dd>
          <dt className="text-[color:var(--color-text-muted)]">Rule</dt>
          <dd className="text-xs">{row.rule_id ? `${row.debit_ratio} · version ${row.rule_version}` : "none applied"}{row.override ? " · amount set by a Super Admin" : ""}</dd>
          <dt className="text-[color:var(--color-text-muted)]">Recorded by</dt><dd className="text-xs">{row.received_by ?? "—"} · {row.livemode ? "live" : "test"}</dd>
        </dl>
        {row.state_note && <p className="rounded-md bg-[color:var(--color-surface-muted)] p-2 text-xs">{row.state_note}</p>}
        {row.problems.length > 0 && (
          <p className="text-xs text-[color:var(--color-warning)]">Not reconciled: {row.problems.join("; ")}.</p>
        )}
        <ol className="space-y-1 text-xs">
          {(chain.data?.events ?? []).map((e, i) => (
            <li key={i}><span className="font-medium">{e.to_state}</span> · {formatDateTime(e.at)} · {e.actor ?? "system"}{e.note ? ` — ${e.note}` : ""}</li>
          ))}
        </ol>
        {(chain.data?.postings ?? []).length > 0 && (
          <ul className="rounded-md border border-[color:var(--color-border)] p-2 text-xs">
            {chain.data!.postings.map((p) => (
              <li key={p.id} className="flex justify-between gap-3 py-0.5">
                <span>#{p.id} {p.kind}{p.reverses_id ? ` (reverses #${p.reverses_id})` : ""} · {String(p.basis.method ?? "")}{p.debit_bps != null ? ` ${p.debit_bps / 100}% v${p.rule_version}` : ""} · {p.actor} · {formatDateTime(p.created_at)}{p.note ? ` — ${p.note}` : ""}</span>
                <span className="font-medium tabular-nums">{p.kind === "CHARGEBACK_DEBIT" ? "−" : "+"} {formatAmount(p.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3">
        {open && (
          <>
            <div className="flex items-end gap-2">
              <div className="flex-1"><Label className="text-xs">Link to pay-in (order id, KTN id or Katana id)</Label><Input value={order} onChange={(e) => setOrder(e.target.value)} /></div>
              <Button size="sm" variant="secondary" disabled={!order.trim() || act.isPending} onClick={() => act.mutate({ action: "link", order: order.trim() })}>Link</Button>
              <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ action: "reevaluate" })}>Check again</Button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_8rem]">
              <div><Label className="text-xs">Note (why)</Label><Input value={note} onChange={(e) => setNote(e.target.value)} /></div>
              <div><Label className="text-xs">Amount (blank = rule)</Label><Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!row.order_id || note.trim().length < 3 || act.isPending}
                onClick={() => act.mutate({ action: "approve", note, amount: amt })}>
                {amt == null ? "Debit by the rule" : amt === 0 ? "No debit" : `Debit ${formatAmount(amt)}`}
              </Button>
              <Button size="sm" variant="ghost" disabled={note.trim().length < 3 || act.isPending}
                onClick={() => act.mutate({ action: "dismiss", note })}>Dismiss: not a chargeback</Button>
            </div>
            <p className="text-[11px] text-[color:var(--color-text-muted)]">An amount the rule did not calculate is a Super Admin&apos;s call and is recorded as one.</p>
          </>
        )}
        {canReverse && (
          <div className="space-y-2 rounded-md border border-[color:var(--color-border)] p-3">
            <div className="font-medium">Give the debit back</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={sel}>
                {REVERSAL_KINDS.map((k) => <option key={k} value={k}>{k.toLowerCase().replace(/_/g, " ")}</option>)}
              </select>
              <Input type="number" placeholder={`up to ${row.debited - row.reversed}`} value={amount} onChange={(e) => setAmount(e.target.value)} />
              <Input placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <Button size="sm" variant="secondary" disabled={note.trim().length < 3 || act.isPending}
              onClick={() => act.mutate({ action: "reverse", kind, note, amount: amt })}>Post reversal</Button>
          </div>
        )}
        {!open && !canReverse && row.state !== "CB_DISMISSED" && row.debited === 0 && (
          <Button size="sm" variant="ghost" disabled={note.trim().length < 3 || act.isPending} onClick={() => act.mutate({ action: "dismiss", note })}>Dismiss</Button>
        )}
      </div>
    </div>
  );
}

// ── Recording chargebacks: one form, or rows pasted from the bank's file ───────────────────────

const CSV_HEAD = "source,bank_ref,original_ref,order_ref,banker,channel,amount,reason_code,reason_text,event_date";

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const split = (l: string) => {
    const out: string[] = []; let cur = ""; let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  };
  const head = split(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}

function RecordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const blank = { source: "BANK", source_name: "", bank_ref: "", original_ref: "", order_ref: "", banker: "", channel: "", amount: "", reason_code: "", reason_text: "", event_date: "" };
  const [f, setF] = useState(blank);
  const [csv, setCsv] = useState("");
  const rowsFromCsv = parseCsv(csv);
  const save = useMutation({
    mutationFn: () => send("/api/chargebacks", csv.trim() ? { records: rowsFromCsv } : f),
    onSuccess: (d: { results: { bank_ref: string; created: boolean; error?: string; chargeback?: StaffChargeback }[] }) => {
      const made = d.results.filter((r) => r.created).length;
      const failed = d.results.filter((r) => r.error);
      toast.success(`${made} recorded, ${d.results.length - made - failed.length} already known`, {
        description: [...d.results.filter((r) => r.chargeback).map((r) => `${r.chargeback!.cb_ref}: ${r.chargeback!.state}`),
          ...failed.map((r) => `${r.bank_ref}: ${r.error}`)].slice(0, 6).join(" · "),
      });
      setF(blank); setCsv(""); onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["chargebacks"] });
    },
    onError: (e: Error) => toast.error("Not recorded", { description: e.message }),
  });
  const field = (k: keyof typeof f, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div><Label className="text-xs">{label}</Label><Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} /></div>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record chargebacks</DialogTitle>
          <DialogDescription>As the bank, acquirer or gateway reported them. Each is matched to its pay-in by order id or payment reference, inside the pay-in&apos;s channel, and ruled on at once. Recording the same bank reference twice changes nothing. The mode (test / live) is the dashboard&apos;s.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><Label className="text-xs">Reported by</Label>
            <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} className={sel}>
              {CB_SOURCES.map((s) => <option key={s}>{s}</option>)}
            </select></div>
          {field("source_name", "Who exactly (staff only)")}
          {field("bank_ref", "Their chargeback reference")}
          {field("amount", "Amount (₹)", { type: "number" })}
          {field("original_ref", "Payment reference (UTR / RRN)")}
          {field("order_ref", "Order id or KTN id (if given)")}
          {field("banker", "Banker code (if known)")}
          <div><Label className="text-xs">Channel (if the record says)</Label>
            <select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} className={sel}>
              <option value="">Not stated</option><option>INTENT</option><option>P2P</option>
            </select></div>
          {field("reason_code", "Reason code")}
          {field("event_date", "Date on the record", { type: "date" })}
          <div className="sm:col-span-2">{field("reason_text", "Reason (as written)")}</div>
        </div>
        <div>
          <Label className="text-xs">Or paste rows from the bank&apos;s file (CSV with a header row)</Label>
          <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={4} placeholder={`${CSV_HEAD}\nBANK,CB778812,412345678901,,M10001,P2P,1000,10.4,Fraud,2026-10-02`}
            className="w-full rounded-md border bg-[color:var(--color-surface)] p-2 font-mono text-xs" />
          {csv.trim() && <p className="text-xs text-[color:var(--color-text-muted)]">{rowsFromCsv.length} row{rowsFromCsv.length === 1 ? "" : "s"} read. The form above is ignored while rows are pasted.</p>}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={save.isPending || (csv.trim() ? !rowsFromCsv.length : !(f.bank_ref && Number(f.amount) > 0 && (f.original_ref || f.order_ref)))}
            onClick={() => save.mutate()}>Record</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Rules ──────────────────────────────────────────────────────────────────────────────────────

interface RuleRow {
  id: string; provider_id: string | null; banker_code: string | null; channel_type: string | null; reason_code: string | null;
  debit_bps: number; auto_debit: boolean; auto_max_amount: number | null; version: number;
  effective_from: string; effective_to: string | null; note: string | null; created_by: string | null;
}

function Rules() {
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const rules = useQuery({
    queryKey: ["chargeback-rules", all],
    queryFn: async () => (await fetch(`/api/chargebacks/rules${all ? "?all=1" : ""}`).then((r) => r.json())) as { rules: RuleRow[] },
  });
  const providers = useQuery({
    queryKey: ["providers-min"],
    queryFn: async () => (await fetch("/api/providers").then((r) => r.json())) as { providers: { id: string; code: string; legal_name: string }[] },
  });
  const nameOf = (id: string | null) => {
    if (!id) return "Every merchant";
    const p = providers.data?.providers?.find((x) => x.id === id);
    return p ? `${p.legal_name} (${p.code})` : id.slice(0, 8);
  };
  const blank = { provider_id: "", banker_code: "", channel_type: "", reason_code: "", debit_percent: "100", auto_debit: true, auto_max_amount: "", note: "" };
  const [f, setF] = useState(blank);
  const create = useMutation({
    mutationFn: () => send("/api/chargebacks/rules", f),
    onSuccess: (d: { rule: RuleRow }) => { toast.success(`Rule set (version ${d.rule.version})`); setF(blank); qc.invalidateQueries({ queryKey: ["chargeback-rules"] }); },
    onError: (e: Error) => toast.error("Not set", { description: e.message }),
  });
  const end = useMutation({
    mutationFn: (id: string) => send("/api/chargebacks/rules", { action: "end", id }),
    onSuccess: () => { toast.success("Rule ended"); qc.invalidateQueries({ queryKey: ["chargeback-rules"] }); },
    onError: (e: Error) => toast.error("Not ended", { description: e.message }),
  });

  const cols: Column<RuleRow>[] = [
    { key: "provider_id", header: "Merchant", render: (r) => <span className="text-xs">{nameOf(r.provider_id)}</span> },
    { key: "banker_code", header: "Banker", render: (r) => <span className="font-mono text-xs">{r.banker_code ?? "all"}</span> },
    { key: "channel_type", header: "Channel", render: (r) => (r.channel_type ? <ChannelBadge channel={r.channel_type} /> : <span className="text-xs">both</span>) },
    { key: "reason_code", header: "Reason", render: (r) => r.reason_code ?? "any" },
    { key: "debit_bps", header: "Debit", render: (r) => <span className="font-medium tabular-nums">{r.debit_bps / 100}%</span> },
    { key: "auto_debit", header: "Automatic", render: (r) => (r.auto_debit ? (r.auto_max_amount ? `up to ${formatAmount(r.auto_max_amount)}` : "yes") : <Badge variant="warning">review every one</Badge>) },
    { key: "version", header: "Version", render: (r) => `v${r.version}` },
    { key: "effective_from", header: "In force", render: (r) => <span className="text-xs">{formatDateTime(r.effective_from)}{r.effective_to ? ` → ${formatDateTime(r.effective_to)}` : ""}</span> },
    { key: "note", header: "Why", render: (r) => <span className="text-xs">{r.note}{r.created_by ? ` · ${r.created_by}` : ""}</span> },
    { key: "id", header: "", render: (r) => (!r.effective_to || Date.parse(r.effective_to) > Date.now()
        ? <Button size="sm" variant="ghost" disabled={end.isPending} onClick={() => end.mutate(r.id)}>End</Button> : null) },
  ];

  return (
    <>
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Set a rule</CardTitle>
          <CardDescription>
            The share of a chargeback debited to the merchant, as agreed with it. The most specific rule in force wins: one banker, then the merchant, then every merchant; then one channel, then one reason code. A new rule for exactly the same scope ends the old one; chargebacks already decided keep the version they used.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div><Label className="text-xs">Merchant</Label>
            <select value={f.provider_id} onChange={(e) => setF({ ...f, provider_id: e.target.value })} className={sel}>
              <option value="">Every merchant</option>
              {(providers.data?.providers ?? []).map((p) => <option key={p.id} value={p.id}>{p.legal_name} ({p.code})</option>)}
            </select></div>
          <div><Label className="text-xs">Banker code (blank = all)</Label><Input value={f.banker_code} onChange={(e) => setF({ ...f, banker_code: e.target.value })} /></div>
          <div><Label className="text-xs">Channel</Label>
            <select value={f.channel_type} onChange={(e) => setF({ ...f, channel_type: e.target.value })} className={sel}>
              <option value="">Both</option><option>INTENT</option><option>P2P</option>
            </select></div>
          <div><Label className="text-xs">Reason code (blank = any)</Label><Input value={f.reason_code} onChange={(e) => setF({ ...f, reason_code: e.target.value })} /></div>
          <div><Label className="text-xs">Debit (% of the chargeback)</Label><Input type="number" min={0} max={100} value={f.debit_percent} onChange={(e) => setF({ ...f, debit_percent: e.target.value })} /></div>
          <div><Label className="text-xs">Automatic up to ₹ (blank = no limit)</Label><Input type="number" value={f.auto_max_amount} onChange={(e) => setF({ ...f, auto_max_amount: e.target.value })} /></div>
          <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={f.auto_debit} onChange={(e) => setF({ ...f, auto_debit: e.target.checked })} /> Debit automatically</label>
          <div className="lg:col-span-4"><Label className="text-xs">Why (the agreement it reflects)</Label><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
          <div><Button disabled={f.note.trim().length < 3 || create.isPending} onClick={() => create.mutate()}>Set rule</Button></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Rules</CardTitle>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show ended rules</label>
        </CardHeader>
        <CardContent>
          <DataTable columns={cols} rows={rules.data?.rules ?? []} rowKey={(r) => r.id} loading={rules.isLoading}
            emptyState="No rules. Until one is set, no chargeback is debited: each waits as a rule exception." />
        </CardContent>
      </Card>
    </>
  );
}
