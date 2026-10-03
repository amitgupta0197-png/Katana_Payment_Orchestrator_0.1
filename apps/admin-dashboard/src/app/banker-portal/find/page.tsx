// Find a payment by order number, UTR, amount or phone (components/portal/find-view).
import { Suspense } from "react";
import { FindView } from "@/components/portal/find-view";

export default function FindPage() {
  return <Suspense><FindView /></Suspense>;
}
