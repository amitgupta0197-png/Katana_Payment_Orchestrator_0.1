// A status in merchants' words (lib/plain-words): Paid, Waiting, Failed, Expired; Sent, On hold…
// The meaning shows on hover and to screen readers.

import { cn } from "@/lib/utils";
import { plainPaymentStatus, plainPayoutStatus, type PlainStatus, type Tone } from "@/lib/plain-words";

const TONE: Record<Tone, string> = {
  success: "bg-[color:var(--color-success-muted)] text-[color:var(--color-success)]",
  warning: "bg-[color:var(--color-warning-muted)] text-[color:var(--color-warning)]",
  danger: "bg-[color:var(--color-danger-muted)] text-[color:var(--color-danger)]",
  info: "bg-[color:var(--color-info-muted)] text-[color:var(--color-info)]",
  neutral: "bg-[color:var(--color-surface-muted)] text-[color:var(--color-text-muted)]",
};

export function StatusPill({ status, className }: { status: PlainStatus; className?: string }) {
  return (
    <span title={status.meaning} className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold", TONE[status.tone], className)}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {status.word}
      <span className="sr-only">: {status.meaning}</span>
    </span>
  );
}

/** A pay-in status as stored or reported anywhere, in merchants' words. */
export function PaymentStatus({ status, className }: { status: string | null | undefined; className?: string }) {
  return <StatusPill status={plainPaymentStatus(status)} className={className} />;
}

/** A payout status, in merchants' words. */
export function PayoutStatus({ status, className }: { status: string | null | undefined; className?: string }) {
  return <StatusPill status={plainPayoutStatus(status)} className={className} />;
}
