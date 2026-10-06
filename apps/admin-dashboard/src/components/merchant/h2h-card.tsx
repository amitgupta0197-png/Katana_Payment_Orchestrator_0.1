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
    onSuccess: (d) => { qc.setQueryData(key, d); toast.success(d.needs_h2h ? "Needs host-to-host: on" : "Needs host-to-host: off"); },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });
  if (q.data === null) return null;   // not staff with access
  const on = q.data?.needs_h2h === true;
  const last = q.data?.history?.[0];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            Host-to-host checkout <InfoTip label="host-to-host checkout">Turn this on if the merchant shows the UPI link on their own page. Then its bankers can only get gateways that send that link.</InfoTip> {on && <Badge variant="info">Needed</Badge>}
          </CardTitle>
          <CardDescription>
            {CHECKOUT_MODE_WORDS.H2H.label}: {CHECKOUT_MODE_WORDS.H2H.detail}. {CHECKOUT_MODE_WORDS.REDIRECT.label}: {CHECKOUT_MODE_WORDS.REDIRECT.detail}.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={on} disabled={q.isLoading || save.isPending}
            onChange={(e) => save.mutate(e.target.checked)} />
          <span>
            This merchant needs host-to-host. Its bankers can only be given payment accounts whose order API returns the UPI link;
            a redirect-only account needs a Super Admin&apos;s note.
          </span>
        </label>
        {last && (
          <div className="text-xs text-[color:var(--color-text-muted)]">
            Last changed {new Date(last.changed_at).toLocaleString("en-IN")}{last.changed_by ? ` by ${last.changed_by}` : ""}.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
