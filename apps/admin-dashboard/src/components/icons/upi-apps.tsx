// Brand marks for the UPI app pay buttons. Each sits on its proper app-icon chip
// (white / branded background) so it stays crisp and recognisable on any theme.
// Dependency-free inline SVG/HTML — no external assets.

export function PaytmLogo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex h-7 items-center justify-center rounded-lg bg-white px-2 shadow-sm shrink-0 ${className ?? ""}`}>
      <svg viewBox="0 0 56 18" height="13" role="img" aria-label="Paytm">
        <text x="0" y="14" fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="16">
          <tspan fill="#013E8E">pay</tspan><tspan fill="#00BAF2">tm</tspan>
        </text>
      </svg>
    </span>
  );
}

export function PhonePeLogo({ className }: { className?: string }) {
  return (
    <span
      className={`inline-flex h-7 w-7 items-center justify-center rounded-lg shadow-sm shrink-0 ${className ?? ""}`}
      style={{ background: "#5F259F" }}
    >
      <svg viewBox="0 0 24 24" height="16" role="img" aria-label="PhonePe">
        <text x="12" y="17" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" fontSize="13" fill="#fff" textAnchor="middle">Pe</text>
      </svg>
    </span>
  );
}

export function GooglePayLogo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex h-7 items-center justify-center rounded-lg bg-white px-2 shadow-sm shrink-0 ${className ?? ""}`}>
      <svg viewBox="0 0 42 18" height="13" role="img" aria-label="Google Pay">
        <text x="0" y="14" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" fontSize="15">
          <tspan fill="#4285F4">G</tspan><tspan fill="#5F6368"> Pay</tspan>
        </text>
      </svg>
    </span>
  );
}
