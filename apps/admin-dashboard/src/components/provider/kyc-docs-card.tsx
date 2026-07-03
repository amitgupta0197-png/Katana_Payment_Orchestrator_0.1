"use client";

// Provider KYC documents: upload (multipart) + verify/unverify + delete.
// Replaces the old stub "Upload" button. Uploading a doc moves its checklist row
// from "missing" → "pending"; verifying it → "ok", which unlocks Approve KYC.

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileCheck2, Plus, Upload, ShieldCheck, ShieldX, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RowActions } from "@/components/world-class/row-actions";
import { EmptyState } from "@/components/world-class/empty-state";
import { formatDateTime } from "@/lib/utils";

interface Doc { id: string; doc_type: string; uri: string; sha256: string; verified_at: string; verified_by: string; created_at: string }

const DOC_TYPES = ["PAN", "GST", "CIN", "MOA", "AOA", "BOARD_RESOLUTION", "ADDRESS_PROOF", "BANK_STATEMENT", "OTHER"] as const;

export function ProviderKycDocsCard({
  providerId, docs, canEdit, canVerify,
}: { providerId: string; docs: Doc[]; canEdit: boolean; canVerify: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [docType, setDocType] = useState<string>("PAN");
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["provider", providerId] });
    qc.invalidateQueries({ queryKey: ["activity", "provider", providerId] });
  };

  const upload = useMutation({
    mutationFn: async () => {
      const f = fileRef.current?.files?.[0];
      if (!f) throw new Error("Choose a file first");
      const fd = new FormData();
      fd.append("doc_type", docType);
      fd.append("file", f);
      const r = await fetch(`/api/providers/${providerId}/kyc-docs`, { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Upload failed");
      return d;
    },
    onSuccess: () => {
      toast.success("Document uploaded");
      setOpen(false);
      if (fileRef.current) fileRef.current.value = "";
      refresh();
    },
    onError: (e: Error) => toast.error("Upload failed", { description: e.message }),
  });

  const verify = useMutation({
    mutationFn: async ({ docId, verified }: { docId: string; verified: boolean }) => {
      const r = await fetch(`/api/providers/${providerId}/kyc-docs/${docId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ verified }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d;
    },
    onSuccess: (_d, v) => { toast.success(v.verified ? "Document verified" : "Verification removed"); refresh(); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const del = useMutation({
    mutationFn: async (docId: string) => {
      const r = await fetch(`/api/providers/${providerId}/kyc-docs/${docId}`, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Failed");
      return d;
    },
    onSuccess: () => { toast.success("Document removed"); refresh(); },
    onError: (e: Error) => toast.error("Failed", { description: e.message }),
  });

  const cols: Column<Doc>[] = [
    { key: "doc_type", header: "Type", render: (r) => <span className="font-medium">{r.doc_type}</span> },
    { key: "sha256", header: "Hash", render: (r) => <span className="font-mono text-xs">{r.sha256.slice(0, 12)}…</span> },
    { key: "verified_at", header: "Verified", render: (r) => r.verified_at
        ? <Badge variant="success">{formatDateTime(r.verified_at)}</Badge>
        : <Badge variant="warning">pending</Badge> },
    { key: "verified_by", header: "By", render: (r) => r.verified_by || "—" },
    { key: "actions", header: "", render: (r) => {
        const actions = [] as { label: string; icon: any; onClick: () => void; variant?: "danger" }[];
        if (canVerify && !r.verified_at) actions.push({ label: "Verify", icon: ShieldCheck, onClick: () => verify.mutate({ docId: r.id, verified: true }) });
        if (canVerify && r.verified_at) actions.push({ label: "Unverify", icon: ShieldX, onClick: () => verify.mutate({ docId: r.id, verified: false }) });
        if (canEdit) actions.push({ label: "Delete", icon: Trash2, variant: "danger", onClick: () => { if (confirm(`Delete ${r.doc_type}?`)) del.mutate(r.id); } });
        return actions.length ? <RowActions actions={actions} /> : null;
      } },
  ];

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Documents ({docs.length})</CardTitle>
          {canEdit && <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Upload</Button>}
        </CardHeader>
        <CardContent>
          {docs.length === 0
            ? <EmptyState icon={FileCheck2} title="No documents uploaded" description="Upload PAN/GST/MOA/AOA/Board Resolution to start the KYC workflow."
                action={canEdit ? { label: "Upload document", icon: Plus, onClick: () => setOpen(true) } : undefined} />
            : <DataTable columns={cols} rows={docs} rowKey={(r) => r.id} />}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload KYC document</DialogTitle>
            <DialogDescription>PNG, JPEG, WEBP or PDF · max 12 MB. The file is hashed (SHA-256) and stored outside the web root.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Document type</Label>
              <select
                value={docType} onChange={(e) => setDocType(e.target.value)}
                className="w-full rounded-md border bg-[color:var(--color-surface)] px-3 py-2 text-sm"
              >
                {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>File</Label>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf"
                className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[color:var(--color-brand)] file:px-3 file:py-1.5 file:text-white" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => upload.mutate()} disabled={upload.isPending}>
              <Upload className="h-4 w-4" /> {upload.isPending ? "Uploading…" : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
