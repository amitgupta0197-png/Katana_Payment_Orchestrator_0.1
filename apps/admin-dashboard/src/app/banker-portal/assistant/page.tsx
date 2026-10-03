// The support assistant for this portal's login (components/support-bot/portal-assistant).
import { Suspense } from "react";
import { PortalAssistant } from "@/components/support-bot/portal-assistant";

export default function AssistantPage() {
  return <Suspense><PortalAssistant /></Suspense>;
}
