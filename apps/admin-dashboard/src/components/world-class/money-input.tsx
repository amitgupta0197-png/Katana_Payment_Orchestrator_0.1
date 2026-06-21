"use client";

// Currency-aware amount input (research-backed error prevention): currency symbol
// adornment, numeric-only keystrokes, thousands grouping on blur, and focus-out
// validation. IMPORTANT: onChange always emits the RAW unformatted numeric string
// (no separators) so existing API calls / toMinor parsing are unchanged — this is
// presentation only.

import { useState } from "react";
import { cn } from "@/lib/utils";

const SYMBOL: Record<string, string> = { INR: "₹", USD: "$", USDT: "₮", EUR: "€", GBP: "£" };

function sanitize(s: string): string {
  let v = s.replace(/[^0-9.]/g, "");
  const parts = v.split(".");
  if (parts.length > 2) v = parts[0] + "." + parts.slice(1).join("");
  const [int, dec] = v.split(".");
  return dec !== undefined ? `${int}.${dec.slice(0, 2)}` : int;
}
function group(s: string): string {
  if (!s) return "";
  const [int, dec] = s.split(".");
  const g = int ? Number(int).toLocaleString("en-IN") : "";
  return dec !== undefined ? `${g}.${dec}` : g;
}

interface MoneyInputProps {
  value: string;
  onChange: (raw: string) => void;
  currency?: string;
  placeholder?: string;
  required?: boolean;   // require a value > 0
  className?: string;
}

export function MoneyInput({ value, onChange, currency = "INR", placeholder, required, className }: MoneyInputProps) {
  const [focused, setFocused] = useState(false);
  const [touched, setTouched] = useState(false);
  const sym = SYMBOL[currency.toUpperCase()] ?? currency.toUpperCase() + " ";
  const invalid = touched && !!required && !(parseFloat(value) > 0);
  const display = focused ? value : group(value);
  return (
    <div className={className}>
      <div className={cn(
        "flex h-9 items-center rounded-md border bg-transparent px-2 text-sm focus-within:ring-1 focus-within:ring-[color:var(--color-brand)]",
        invalid && "border-[color:var(--color-danger)]",
      )}>
        <span className="mr-1 shrink-0 text-[color:var(--color-text-muted)]">{sym}</span>
        <input
          inputMode="decimal"
          className="h-full w-full bg-transparent outline-none"
          placeholder={placeholder ?? "0"}
          value={display}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); setTouched(true); }}
          onChange={(e) => onChange(sanitize(e.target.value))}
        />
      </div>
      {invalid && <p className="mt-1 text-xs text-[color:var(--color-danger)]">Enter an amount greater than {sym}0.</p>}
    </div>
  );
}
