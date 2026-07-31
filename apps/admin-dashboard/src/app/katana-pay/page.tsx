// Katana Pay — home. Hero over the nebula (background + nav + footer come from layout.tsx).

import type { Metadata } from "next";
import { Hero } from "./_experience/Hero";
import { Ecosystem } from "./_experience/Ecosystem";
import { Products } from "./_experience/Products";
import { CtaBand } from "./_experience/CtaBand";

export const metadata: Metadata = {
  title: "Katana Pay — Move money like it's frictionless",
  description:
    "Katana Pay is a payment orchestration platform for UPI-first businesses: hosted UPI checkout for any website, real-time reconciliation, smart multi-provider routing, and fast branch settlements — behind one signed API.",
  openGraph: {
    title: "Katana Pay — Move money like it's frictionless",
    description: "Hosted UPI checkout, real-time reconciliation, smart routing, and fast settlements. Integrate in any language.",
    type: "website",
  },
};

export default function KatanaPayHome() {
  return (
    <>
      <Hero />
      <Ecosystem />
      <Products />
      <CtaBand />
    </>
  );
}
