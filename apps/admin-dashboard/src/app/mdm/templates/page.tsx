"use client";

// Template Manager: each master type's field schema (components/mdm/template-manager). Staff only.

import { Suspense } from "react";
import { TemplateManager } from "@/components/mdm/template-manager";

export default function MdmTemplatesPage() {
  return <Suspense fallback={null}><TemplateManager /></Suspense>;
}
