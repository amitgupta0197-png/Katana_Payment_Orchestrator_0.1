import type { Metadata } from "next";
import { DocsContent } from "../_experience/DocsContent";

export const metadata: Metadata = {
  title: "Docs — Katana Pay",
  description: "Katana Pay developer docs: credentials, endpoints, creating a signed order, request signing, and verifying the status callback.",
};

export default function DocsPage() {
  return <DocsContent />;
}
