// The technical name of a thing, shown small and grey beside its plain-words label (staff screens),
// for people who know the term: "Payment account" · pay-in gateway.

export function TechLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`ml-1.5 align-middle font-mono text-[10px] font-normal uppercase tracking-wider text-[color:var(--color-text-subtle)] ${className}`}>
      {children}
    </span>
  );
}
