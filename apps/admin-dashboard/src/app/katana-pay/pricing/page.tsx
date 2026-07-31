import type { Metadata } from "next";
import { Pricing } from "../_experience/Pricing";
import { CtaBand } from "../_experience/CtaBand";

export const metadata: Metadata = {
  title: "Pricing — Katana Pay",
  description: "Start free. Pay a clear MDR as you scale. Starter, Growth, and Enterprise plans — no hidden gateway markup.",
};

export default function PricingPage() {
  return (
    <div className="pt-24">
      <Pricing />
      <CtaBand />
    </div>
  );
}
