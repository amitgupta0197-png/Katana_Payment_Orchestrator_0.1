"use client";

// Whether a merchant needs host-to-host checkout (providers.needs_h2h, lib/checkout-mode-store).
// Staff (Super Admin, Admin) switch it; its bankers then get only host-to-host payment accounts.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { Badge } from "@/components/ui/badge";
import { CHECKOUT_MODE_WORDS } from "@/lib/pg-catalog";

interface H2hState { needs_h2h: boolean; history: { from_value: boolean | null; to_value: boolean; changed_by: string | null; changed_at: string }[] }

export function H2hCard({ providerId }: { providerId: string }) {
  const qc = useQueryClient();
  const key = ["provider", providerId, "h2h"];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/providers/${providerId}/h2h`);
      if (r.status === 403) return null;
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
      return d as H2hState;
    },
  });
  const save = useMutation({
    mutationFn: async (value: boolean) => {
      const r = await fetch(`/api/providers/${providerId}/h2h`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ needs_h2h: value }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d as H2hState;
    },
    onSuccess: (d) => { qc.setQueryData(key, d); toast.success(d.needs_h2h ? "Intent checkout: H2H" : "Intent checkout: Redirect"); },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });
  if (q.data === null) return null;   // not staff with access
  const on = q.data?.needs_h2h === true;
  const last = q.data?.history?.[0];
  // Off with no history: nobody has chosen yet (every merchant from before provider 0023).
  const chosen = on || !!q.data?.history?.length;
  const busy = q.isLoading || save.isPending;
  const options: { value: boolean; title: string; body: string }[] = [
    { value: true, title: `${CHECKOUT_MODE_WORDS.H2H.label} (H2H)`, body: `${CHECKOUT_MODE_WORDS.H2H.detail}. Its bankers can only be given payment accounts that send the UPI link; a redirect-only account needs a Super Admin's note.` },
    { value: false, title: "Redirect is fine", body: `${CHECKOUT_MODE_WORDS.REDIRECT.detail}. Any payment account can be used.` },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            Intent checkout <InfoTip label="Intent checkout">How this merchant&apos;s customers pay on the Intent flow. H2H: the merchant shows the UPI link on its own page, so its bankers can only get gateways that send that link. Redirect: the customer pays on a hosted page.</InfoTip>
            {chosen ? <Badge variant={on ? "info" : "default"}>{on ? "H2H" : "Redirect"}</Badge> : <Badge variant="warning">Not chosen</Badge>}
          </CardTitle>
          <CardDescription>Will this merchant show the UPI link on its own page, or send customers to a payment page?</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div role="radiogroup" aria-label="Intent checkout" className="grid gap-2 sm:grid-cols-2">
          {options.map((o) => {
            const sel = chosen && on === o.value;
            return (
              <button key={String(o.value)} type="button" role="radio" aria-checked={sel} disabled={busy}
                onClick={() => { if (!sel) save.mutate(o.value); }}
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
          A banker with its own choice (banker page → Pays via gateway) keeps it. Changing this does not change a payment account already connected: a banker on a redirect-only account stays on redirect until its account is replaced.
          {last && <> Last changed {new Date(last.changed_at).toLocaleString("en-IN")}{last.changed_by ? ` by ${last.changed_by}` : ""}.</>}
        </div>
      </CardContent>
    </Card>
  );
}
