"use client";

// Promise-based single-input dialog — a friendly replacement for window.prompt for
// actions that need one value + a confirm (e.g. refund amount, dispute reason).
// Presentation only; it just collects a value and resolves it.
//
// Usage:
//   const { prompt, dialog } = useInputDialog();
//   const v = await prompt({ title: "Refund", label: "Amount (blank = full)" });
//   if (v !== null) mutate(v);
//   return (<>{dialog} ...</>)

import { useCallback, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface PromptOpts {
  title: string;
  body?: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  confirmLabel?: string;
  danger?: boolean;
}

export function useInputDialog() {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<PromptOpts>({ title: "" });
  const [val, setVal] = useState("");
  const resolver = useRef<((v: string | null) => void) | null>(null);

  const prompt = useCallback((o: PromptOpts) => {
    setOpts(o);
    setVal(o.defaultValue ?? "");
    setOpen(true);
    return new Promise<string | null>((resolve) => { resolver.current = resolve; });
  }, []);

  const settle = (v: string | null) => {
    setOpen(false);
    resolver.current?.(v);
    resolver.current = null;
  };

  const canSubmit = !opts.required || val.trim().length > 0;

  const dialog = (
    <Dialog open={open} onOpenChange={(o) => { if (!o) settle(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{opts.title}</DialogTitle>
          <DialogDescription>{opts.body ?? opts.label ?? " "}</DialogDescription>
        </DialogHeader>
        {opts.label && <label className="text-xs text-[color:var(--color-text-muted)]">{opts.label}</label>}
        <Input
          autoFocus
          placeholder={opts.placeholder}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && canSubmit) settle(val.trim()); }}
        />
        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={() => settle(null)}>Cancel</Button>
          <Button variant={opts.danger ? "danger" : "default"} size="sm" disabled={!canSubmit} onClick={() => settle(val.trim())}>
            {opts.confirmLabel ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { prompt, dialog };
}
