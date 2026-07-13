"use client";

// Admin view of partner / contact-us submissions from the public landing form.
// Lists newest-first with a per-row status control (NEW → CONTACTED → CLOSED).

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Headphones } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";

interface Inquiry {
  id: string; name: string; email: string; phone: string; company: string;
  partner_type: string; message: string; status: "NEW" | "CONTACTED" | "CLOSED";
  source: string; created_at: string;
}

const STATUS_VARIANT: Record<Inquiry["status"], "info" | "warning" | "default"> = {
  NEW: "info", CONTACTED: "warning", CLOSED: "default",
};

export default function PartnerInquiriesPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["partner-inquiries"],
    queryFn: async () =>
      (await fetch("/api/partner-inquiries").then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
        return d;
      })) as { inquiries: Inquiry[]; new_count: number },
  });

  const setStatus = useMutation({
    mutationFn: async (v: { id: string; status: Inquiry["status"] }) => {
      const r = await fetch("/api/partner-inquiries", {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(v),
      });
      if (!r.ok) throw new Error("update failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["partner-inquiries"] }),
  });

  const cols: Column<Inquiry>[] = [
    { key: "created_at", header: "When", render: (r) => formatDateTime(r.created_at) },
    { key: "name", header: "Name", render: (r) => <span className="font-medium">{r.name}</span> },
    { key: "email", header: "Email", render: (r) => <a href={`mailto:${r.email}`} className="text-[color:var(--color-brand)] hover:underline">{r.email}</a> },
    { key: "phone", header: "Phone", render: (r) => r.phone || "—" },
    { key: "company", header: "Company", render: (r) => r.company || "—" },
    { key: "partner_type", header: "Interest", render: (r) => r.partner_type || "—" },
    { key: "message", header: "Message", render: (r) => r.message ? <span title={r.message} className="block max-w-xs truncate">{r.message}</span> : "—" },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge> },
    {
      key: "id", header: "Set status", render: (r) => (
        <select
          className="rounded-md border border-[color:var(--color-border-strong)] bg-[color:var(--color-surface)] px-2 py-1 text-xs"
          value={r.status}
          disabled={setStatus.isPending}
          onChange={(e) => setStatus.mutate({ id: r.id, status: e.target.value as Inquiry["status"] })}
        >
          <option value="NEW">New</option>
          <option value="CONTACTED">Contacted</option>
          <option value="CLOSED">Closed</option>
        </select>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Partner Inquiries"
        description="Contact-us submissions from the public Katana Pay landing form."
        icon={Headphones}
      />
      <Card>
        <CardHeader>
          <CardTitle>
            {(q.data?.inquiries ?? []).length} total
            {q.data?.new_count ? ` · ${q.data.new_count} new` : ""}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={q.data?.inquiries ?? []}
            loading={q.isLoading}
            rowKey={(r) => r.id}
            emptyState="No partner inquiries yet."
          />
        </CardContent>
      </Card>
    </>
  );
}
