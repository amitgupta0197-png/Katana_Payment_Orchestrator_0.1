"use client";

// Reusable promise-based confirmation dialog for irreversible / high-stakes actions
// (BRD-aligned: intentional friction on money movement). Presentation only — it
// gates the SAME action behind an explicit confirm; it changes no business logic.
//
// Usage:
//   const { confirm, dialog } = useConfirm();
//   ... onClick={async () => { if (await confirm({ title, body, danger:true, confirmLabel:"Pay" })) mutate(); }}
//   return (<>{dialog} ...</>)

import { useCallback, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmOpts {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
}

export function useConfirm() {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOpts>({ title: "" });
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOpts) => {
    setOpts(o);
    setOpen(true);
    return new Promise<boolean>((resolve) => { resolver.current = resolve; });
  }, []);

  const settle = (v: boolean) => {
    setOpen(false);
    resolver.current?.(v);
    resolver.current = null;
  };

  const dialog = (
    <Dialog open={open} onOpenChange={(o) => { if (!o) settle(false); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{opts.title}</DialogTitle>
          <DialogDescription>{opts.body ?? "This action cannot be undone."}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={() => settle(false)}>Cancel</Button>
          <Button variant={opts.danger ? "danger" : "default"} size="sm" onClick={() => settle(true)}>
            {opts.confirmLabel ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, dialog };
}
