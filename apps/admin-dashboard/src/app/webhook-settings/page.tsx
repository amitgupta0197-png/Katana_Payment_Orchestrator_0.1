"use client";

// Staff: a banker's webhook version, events, callback URL, signing secret, test events and v2
// keys (components/portal/webhooks-panel), chosen by banker code.

import { WebhooksPanel } from "@/components/portal/webhooks-panel";

export default function Page() {
  return <WebhooksPanel staff />;
}
