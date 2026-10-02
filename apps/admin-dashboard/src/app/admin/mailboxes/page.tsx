"use client";

// Mailboxes linked for payment mail. One is read only after a Super Admin approves it here:
// it is linked from the phone app without a login, and mail from it can mark an order paid.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";

interface Inbox {
  id: string; merchant_id: string | null; email: string; auth_type: string; host: string | null;
  enabled: boolean; approved: boolean; approved_by: string | null; approved_at: string | null;
  linked_via: string | null; status: string | null; last_polled_at: string | null; created_at: string;
}

const VIA: Record<string, string> = { OAUTH_LINK: "Google sign-in from the app", DEVICE: "app password from a phone" };

export default function MailboxesPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin-email-inboxes"],
    queryFn: async () => {
      const r = await fetch("/api/admin/email-inboxes");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return d.inboxes as Inbox[];
    },
  });
  const act = useMutation({
    mutationFn: async (v: { email: string; action: "approve" | "disable" }) => {
      const r = await fetch("/api/admin/email-inboxes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "HTTP " + r.status);
      return v.action;
    },
    onSuccess: (a) => { toast.success(a === "approve" ? "Mailbox approved" : "Mailbox switched off"); qc.invalidateQueries({ queryKey: ["admin-email-inboxes"] }); },
    onError: (e: Error) => toast.error("Not saved", { description: e.message }),
  });
  const inboxes = q.data ?? [];
  const waiting = inboxes.filter((i) => i.enabled && !i.approved).length;

  return (
    <div>
      <PageHeader
        title="Mailboxes" icon={Mail}
        description="Mailboxes linked to read payment mail. A mailbox is linked from the phone app without a login, so nothing is read from one until it is approved here. Approve only after checking it is the merchant's own."
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            Linked mailboxes {waiting > 0 && <Badge variant="warning">{waiting} waiting for approval</Badge>}
          </CardTitle>
          <CardDescription>Mail is acted on only when the mailbox's own server authenticated it as coming from a payment provider.</CardDescription>
        </CardHeader>
        <CardContent>
          {q.isLoading ? <p className="text-sm text-[color:var(--color-text-muted)]">Loading…</p>
            : q.error ? <p className="text-sm text-[color:var(--color-danger)]">{(q.error as Error).message}</p>
            : inboxes.length === 0 ? <p className="text-sm text-[color:var(--color-text-muted)]">No mailbox is linked.</p>
            : (
              <ul className="space-y-2">
                {inboxes.map((i) => (
                  <li key={i.id} className="rounded-md border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={i.approved ? "success" : i.enabled ? "warning" : "default"}>{i.approved ? "Approved" : i.enabled ? "Waiting" : "Off"}</Badge>
                      <span className="font-medium">{i.email}</span>
                      <span className="font-mono text-xs">{i.merchant_id ?? "no merchant"}</span>
                      <span className="ml-auto flex gap-2">
                        {!i.approved && <Button size="sm" disabled={act.isPending || !i.merchant_id} onClick={() => act.mutate({ email: i.email, action: "approve" })}>Approve</Button>}
                        {(i.approved || i.enabled) && <Button size="sm" variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ email: i.email, action: "disable" })}>Switch off</Button>}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-[color:var(--color-text-muted)]">
                      Linked {formatDateTime(i.created_at)}{i.linked_via ? ` by ${VIA[i.linked_via] ?? i.linked_via}` : ""}
                      {i.approved_by ? ` · approved by ${i.approved_by}` : ""}
                      {i.last_polled_at ? ` · last read ${formatDateTime(i.last_polled_at)}` : ""}
                      {i.status && i.status !== "OK" ? ` · ${i.status}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </CardContent>
      </Card>
    </div>
  );
}
