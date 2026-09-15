// Full-width strip shown under the header while the dashboard is switched to test data.
// No hooks, so both the server admin layout and the client portal shells can render it.

import { FlaskConical } from "lucide-react";

export function TestModeBanner({ livemode }: { livemode: boolean }) {
  if (livemode) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 border-b border-[color:var(--color-testmode)] bg-[color:var(--color-testmode-muted)] px-4 py-1.5 text-center text-xs font-medium text-[color:var(--color-testmode-text)]"
    >
      <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>Test mode: you&apos;re viewing test data. Test orders use test keys and never move real money.</span>
    </div>
  );
}
