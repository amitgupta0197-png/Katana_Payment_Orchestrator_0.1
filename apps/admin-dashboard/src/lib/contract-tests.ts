// Adapter contract tests (BRD §3 "Contract Testing").
//
// For each registered PaymentAdapter we drive a synthetic charge/refund/
// getStatus cycle and check the response SHAPE — not the values, which are
// deterministic but adapter-specific. A failing contract is a hard release
// blocker per BRD §22.

import { getAdapter, listAdapterCodes } from "@/lib/payment-adapters";

export interface ContractCheck { name: string; ok: boolean; reason?: string }
export interface ContractReport {
  provider: string;
  passed: number; failed: number;
  checks: ContractCheck[];
}

function expect(name: string, cond: boolean, reason?: string): ContractCheck {
  return { name, ok: cond, reason: cond ? undefined : reason };
}

export async function runContractsFor(provider: string): Promise<ContractReport> {
  const adapter = getAdapter(provider);
  const checks: ContractCheck[] = [];
  try {
    const charge = await adapter.charge({
      orderId: "ct-order", txnId: "TXN-CONTRACT", amountMinor: 25000n,
      currency: "INR", method: "UPI_INTENT", attemptNo: 1,
    });
    checks.push(expect("charge.outcome is enum",
      ["SUCCESS","AUTH_REQUIRED","PROCESSING","FAILED"].includes(charge.outcome),
      `outcome=${charge.outcome}`));
    checks.push(expect("charge.nextState present", typeof charge.nextState === "string"));
    checks.push(expect("charge.providerTxnId set on non-failure",
      charge.outcome === "FAILED" || !!charge.providerTxnId, "missing provider_txn_id"));
    checks.push(expect("charge.responseTimeMs is number",
      typeof charge.responseTimeMs === "number" && charge.responseTimeMs >= 0));

    const refund = await adapter.refund({ providerTxnId: "pgt_demo", amountMinor: 10000n, currency: "INR" });
    checks.push(expect("refund.ok is boolean", typeof refund.ok === "boolean"));
    checks.push(expect("refund.provider matches", refund.provider.toUpperCase() === provider.toUpperCase()));

    const status = await adapter.getStatus("pgt_demo");
    checks.push(expect("getStatus.status is string", typeof status.status === "string"));
  } catch (e) {
    checks.push(expect("adapter did not throw", false, (e as Error).message));
  }
  const passed = checks.filter(c => c.ok).length;
  return { provider, passed, failed: checks.length - passed, checks };
}

export async function runAllContracts(): Promise<{ reports: ContractReport[]; all_passed: boolean }> {
  const reports = await Promise.all(listAdapterCodes().map(runContractsFor));
  return { reports, all_passed: reports.every(r => r.failed === 0) };
}
