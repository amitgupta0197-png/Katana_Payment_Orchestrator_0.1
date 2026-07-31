import type { Metadata } from "next";
import { Features } from "../_experience/Features";
import { CtaBand } from "../_experience/CtaBand";

export const metadata: Metadata = {
  title: "Features — Katana Pay",
  description: "Hosted checkout in any language, real-time reconciliation, smart multi-merchant routing, on-device RRN capture, fast banker settlements, and a developer-first API.",
};

export default function FeaturesPage() {
  return (
    <div className="pt-24">
      <Features />
      <CtaBand />
    </div>
  );
}
