"use client";

// A banker's KYB identifiers and the result of each onboarding check. The identifiers are
// checked for form as they are saved; the checks themselves run when an onboarding step is
// advanced and are listed here, newest first.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/utils";

const FIELDS = [
  { key: "gstin", label: "GSTIN", placeholder: "15 characters" },
  { key: "business_pan", label: "Business PAN", placeholder: "10 characters" },
  { key: "director_name", label: "Director / proprietor name", placeholder: "as on the PAN" },
  { key: "director_pan", label: "Director PAN", placeholder: "10 characters" },
  { key: "director_aadhaar_last4", label: "Director Aadhaar (last 4 only)", placeholder: "1234" },
  { key: "category_mcc", label: "Category (MCC)", placeholder: "4 digits" },
  { key: "est_monthly_volume", label: "Expected monthly volume (₹)", placeholder: "e.g. 500000" },
  { key: "website", label: "Website", placeholder: "https://…" },
] as const;
type Key = (typeof FIELDS)[number]["key"];
type Form = Record<Key, string>;

interface Gate { id: string; gate: string; result: "PASS" | "REVIEW" | "FAIL"; detail: { summary?: string }; overridden_by: string | null; checked_at: string }
interface Data { details: Record<Key, string | null>; gates: Gate[]; required_documents: string[]; strict: boolean }

const VARIANT = { PASS: "success", REVIEW: "warning", FAIL: "danger" } as const;
const EMPTY = Object.fromEntries(FIELDS.map((f) => [f.key, ""])) as Form;

export function OnboardingChecksCard({ merchantId }: { merchantId: string }) {
  const qc = useQueryClient();
  const key = ["merchant", merchantId, "onboarding-gates"];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/onboarding-gates`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d as Data;
    },
  });
  const [form, setForm] = useState<Form>(EMPTY);
  useEffect(() => {
    if (q.data) setForm(Object.fromEntries(FIELDS.map((f) => [f.key, q.data!.details[f.key] ?? ""])) as Form);
  }, [q.data]);

  const save = useMutation({
    mutationFn: async () => {
      // Only what changed is sent, so a field left alone is never rewritten.
      const changed = Object.fromEntries(FIELDS.filter((f) => form[f.key] !== (q.data?.details[f.key] ?? "")).map((f) => [f.key, form[f.key]]));
      if (!Object.keys(changed).length) throw new Error("nothing changed");
      const r = await fetch(`/api/merchants/${merchantId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changed),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d;
    },
    onSuccess: () => { toast.success("KYB details saved"); qc.invalidateQueries({ queryKey: key }); },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });

  const gates = q.data?.gates ?? [];
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-base">KYB details and onboarding checks</CardTitle>
        <CardDescription>
          The identifiers are checked for form and against each other. They are not yet verified with the GST network,
          the income-tax department or the bank: those checks stay with a person.
          {q.data ? ` Documents needed: ${q.data.required_documents.join(", ").replace(/_/g, " ")}.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label>{f.label}</Label>
              <Input value={form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} placeholder={f.placeholder} />
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !q.data}>{save.isPending ? "Saving…" : "Save details"}</Button>
        </div>
        <div>
          <div className="mb-2 font-medium">Checks run by the system</div>
          {gates.length === 0 ? (
            <p className="text-xs text-[color:var(--color-text-muted)]">None yet. They run when an onboarding step is advanced.</p>
          ) : (
            <ul className="space-y-1.5">
              {gates.map((g) => (
                <li key={g.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant={VARIANT[g.result]}>{g.result}</Badge>
                  <span className="font-medium">{g.gate}</span>
                  <span className="min-w-0 flex-1">{g.detail.summary ?? ""}</span>
                  {g.overridden_by && <Badge variant="warning">overridden by {g.overridden_by}</Badge>}
                  <span className="text-[color:var(--color-text-muted)]">{formatDateTime(g.checked_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
