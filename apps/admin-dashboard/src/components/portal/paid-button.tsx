"use client";

// "Customer says they paid": on an order that is not Paid, one tap opens the assistant with the
// order filled in and asks for the customer's payment screenshot. Without the assistant it leads
// to Katana support instead. Shown in the portals only (usePortal), never on staff pages.

import Link from "next/link";
import { MessageCircleQuestion } from "lucide-react";
import { cn } from "@/lib/utils";
import { plainPaymentStatus } from "@/lib/plain-words";
import { usePortal } from "@/components/portal/portal-frame";

export function paidQuestion(txnid: string): string {
  return `My customer says they paid for order ${txnid}, but it is not showing as paid. What happened?`;
}

export function PaidButton({ txnid, status, className, compact }: { txnid: string; status: string | null | undefined; className?: string; compact?: boolean }) {
  const portal = usePortal();
  if (!portal || plainPaymentStatus(status).word === "Paid") return null;
  const href = portal.assistant
    ? `${portal.base}/assistant?ask=${encodeURIComponent(paidQuestion(txnid))}&screenshot=1`
    : portal.base === "/merchant-portal" ? `${portal.base}/tickets` : `${portal.base}/help`;
  return (
    <Link href={href} onClick={(e) => e.stopPropagation()}
      className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[color:var(--color-brand)]/40 px-3 text-sm font-medium text-[color:var(--color-brand)] transition-colors hover:bg-[color:var(--color-brand-muted)]", className)}>
      <MessageCircleQuestion className="h-4 w-4" />
      {compact ? "Customer paid?" : "Customer says they paid"}
    </Link>
  );
}
