"use client";

// A banker's Intent checkout: H2H or redirect (merchants.needs_h2h, lib/checkout-mode-store).
// "Same as merchant" follows the merchant's choice; H2H or Redirect is the banker's own and wins.
// Staff (Super Admin, Admin) only; the card hides itself for anyone else.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { Badge } from "@/components/ui/badge";
import { CHECKOUT_MODE_WORDS } from "@/lib/pg-catalog";

interface BankerH2hState {
  needs_h2h: boolean | null; merchant_needs_h2h: boolean; merchant_chosen: boolean; effective: boolean;
  history: { from_value: boolean | null; to_value: boolean | null; changed_by: string | null; changed_at: string }[];
}

type Pick = "MERCHANT" | "H2H" | "REDIRECT";
const VALUE: Record<Pick, boolean | null> = { MERCHANT: null, H2H: true, REDIRECT: false };
const word = (v: boolean) => (v ? "H2H" : "Redirect");

export function BankerH2hCard({ merchantId }: { merchantId: string }) {
  const qc = useQueryClient();
  const key = ["merchant", merchantId, "h2h"];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/merchants/${merchantId}/h2h`);
      if (r.status === 403) return null;
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as BankerH2hState;
    },
  });
  const save = useMutation({
    mutationFn: async (value: boolean | null) => {
      const r = await fetch(`/api/merchants/${merchantId}/h2h`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ needs_h2h: value }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as BankerH2hState;
    },
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      // The payment account card warns and limits gateways by this.
      qc.invalidateQueries({ queryKey: ["merchant", merchantId, "gateway-mid"] });
      toast.success(`Intent checkout: ${word(d.effective)}${d.needs_h2h === null ? " (same as merchant)" : ""}`);
    },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });
  if (q.data === null) return null;   // not staff with access
  const d = q.data;
  const pick: Pick | null = !d ? null : d.needs_h2h === null ? "MERCHANT" : d.needs_h2h ? "H2H" : "REDIRECT";
  const merchantWord = !d ? "…" : d.merchant_chosen ? word(d.merchant_needs_h2h) : "not chosen, so Redirect";
  const busy = q.isLoading || save.isPending;
  const last = d?.history?.[0];
  const options: { value: Pick; title: string; body: string }[] = [
    { value: "MERCHANT", title: "Same as merchant", body: `Follows the merchant's choice: ${merchantWord}.` },
    { value: "H2H", title: `${CHECKOUT_MODE_WORDS.H2H.label} (H2H)`, body: `${CHECKOUT_MODE_WORDS.H2H.detail}. Only payment accounts that send the UPI link; a redirect-only one needs a Super Admin's note.` },
    { value: "REDIRECT", title: "Redirect is fine", body: `${CHECKOUT_MODE_WORDS.REDIRECT.detail}. Any payment account can be used.` },
  ];

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Intent checkout
          <InfoTip label="Intent checkout">H2H: this banker&apos;s order API returns the UPI link and QR, so it can only get gateways that send that link. Redirect: the customer pays on a hosted page. Same as merchant follows the merchant&apos;s setting; a banker&apos;s own choice wins.</InfoTip>
          {d && <Badge variant={d.effective ? "info" : "default"}>{word(d.effective)}</Badge>}
        </CardTitle>
        <CardDescription>Will this banker&apos;s orders show the UPI link on the merchant&apos;s own page, or send customers to a payment page?</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div role="radiogroup" aria-label="Intent checkout" className="grid gap-2 sm:grid-cols-3">
          {options.map((o) => {
            const sel = pick === o.value;
            return (
              <button key={o.value} type="button" role="radio" aria-checked={sel} disabled={busy}
                onClick={() => { if (!sel) save.mutate(VALUE[o.value]); }}
                className={`rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-60 ${sel
                  ? "border-[color:var(--color-brand)] bg-[color:var(--color-brand-muted)]"
                  : "border-[color:var(--color-border)] hover:border-[color:var(--color-text-muted)]"}`}>
                <span className="block font-medium">{o.title}</span>
                <span className="mt-0.5 block text-xs text-[color:var(--color-text-muted)]">{o.body}</span>
              </button>
            );
          })}
        </div>
        <div className="text-xs text-[color:var(--color-text-muted)]">
          This does not change the payment account already connected: a redirect-only account stays on redirect until it is replaced.
          {last && <> Last changed {new Date(last.changed_at).toLocaleString("en-IN")}{last.changed_by ? ` by ${last.changed_by}` : ""}.</>}
        </div>
      </CardContent>
    </Card>
  );
}
