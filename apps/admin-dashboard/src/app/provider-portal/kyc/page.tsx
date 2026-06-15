"use client";

import { useQuery } from "@tanstack/react-query";
import { FileCheck2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { statusVariant } from "@/lib/utils";

interface Provider {
  id: string; code: string; legal_name: string; kyc_status: string; status: string;
  doc_count: number; user_count: number; merchant_count: number;
}

const REQUIRED_DOCS = ["PAN", "GST", "CIN", "MOA", "AOA", "BOARD_RESOLUTION", "ADDRESS_PROOF", "BANK_STATEMENT"] as const;

export default function ProviderKycPage() {
  const q = useQuery({
    queryKey: ["pp:providers"],
    queryFn: async () => (await fetch("/api/providers").then((r) => r.json())) as { providers: Provider[] },
  });

  const me = q.data?.providers?.[0];

  // TODO: provider doc list endpoint. Until then, render the required-doc checklist
  // shape so the user sees which docs the platform expects per §2.1 step 2.
  const checklist = REQUIRED_DOCS.map((kind) => ({ kind, status: "NOT_UPLOADED" as const }));

  const cols: Column<typeof checklist[number]>[] = [
    { key: "kind", header: "Document" },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status === "NOT_UPLOADED" ? "PENDING" : r.status)}>{r.status}</Badge> },
  ];

  return (
    <>
      <PageHeader
        title="Provider KYC"
        description="Required KYC documents to keep your provider in good standing."
        icon={FileCheck2}
      />
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>{me?.legal_name ?? "Your provider"}</CardTitle>
          <CardDescription>
            Status: <Badge variant={statusVariant(me?.status)}>{me?.status ?? "—"}</Badge>{" "}
            · KYC: <Badge variant={statusVariant(me?.kyc_status)}>{me?.kyc_status ?? "—"}</Badge>
          </CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader><CardTitle>Document checklist</CardTitle></CardHeader>
        <CardContent>
          <DataTable
            columns={cols}
            rows={checklist}
            rowKey={(r) => r.kind}
            emptyState="No documents required."
          />
        </CardContent>
      </Card>
    </>
  );
}
