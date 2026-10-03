"use client";

// Key + Salt for each of the merchant's bankers, in the main menu. The same cards as the Integration
// page and each banker's own page (components/merchant/checkout-key-card): a test pair at any time,
// the live pair once the banker is activated for live; the Salt is shown once, when it is made.

import Link from "next/link";
import { KeyRound } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { BankerCredentials } from "../integration/guide";

export default function MerchantKeysPage() {
  return (
    <>
      <PageHeader
        title="Key + Salt"
        description="Generate the Key and Salt your developers sign requests with, for each of your bankers. Copy the Salt when it is shown; it is not shown again."
        icon={KeyRound}
      />
      <BankerCredentials />
      <p className="mt-2 text-sm text-[color:var(--color-text-muted)]">
        How to use them: the <Link className="text-[color:var(--color-brand)] hover:underline" href="/merchant-portal/integration">integration guide</Link>.
      </p>
    </>
  );
}
