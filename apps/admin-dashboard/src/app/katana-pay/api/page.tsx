import type { Metadata } from "next";
import { ApiTerminal } from "../_experience/ApiTerminal";
import { CtaBand } from "../_experience/CtaBand";

export const metadata: Metadata = {
  title: "API — Katana Pay",
  description: "Sign the order with your per-branch Key + Salt, POST it, and redirect to the returned pay_url. Katana handles UPI, reconciliation, and the signed status callback.",
};

export default function ApiPage() {
  return (
    <div className="pt-24">
      <ApiTerminal />
      <CtaBand />
    </div>
  );
}
