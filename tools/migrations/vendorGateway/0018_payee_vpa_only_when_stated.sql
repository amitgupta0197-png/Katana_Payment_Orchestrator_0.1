-- payee_vpa means "the VPA this payment named", not "the VPA we assume it used".
--
-- Ingestion used to fall back to the banker's configured PRIMARY settlement VPA whenever a
-- credit arrived without one. GPay for Business never reports which UPI ID the customer paid
-- — not in the push, not on the detail screen — so that guess was applied to essentially
-- every captured credit, and the dashboard rendered it as fact. A banker receiving on four
-- IDs (PRVZS23) saw all four IDs' payments listed against the primary, which is exactly the
-- discrepancy reported on 2026-08-17: 74 of 76 stored credits carried the primary VPA and not
-- one carried any of the three additional IDs.
--
-- The fallback is gone from lib/txn-reconcile.ts. This clears the guesses it already wrote so
-- a NULL genuinely means "the payment did not say", which the UI now renders as the banker's
-- settlement account instead of naming a UPI ID.
--
-- NOTHING DEPENDS ON THE GUESS. Credits are attributed by the banker code the capture device
-- stamps (merchant_id) — the only reliable key, since bankers share settlement VPAs. The
-- payee_vpa scoping fallback in the portals applies only to rows with NO banker code, and the
-- guess required one, so those rows are untouched by both the code change and this UPDATE.

UPDATE vendor_txn_alerts
   SET payee_vpa = NULL,
       detail = COALESCE(NULLIF(detail,''), '')
                || CASE WHEN COALESCE(detail,'') = '' THEN '' ELSE ' · ' END
                || 'payee VPA cleared: it was assumed from config, not stated by the payment (0018)'
 WHERE COALESCE(direction,'CREDIT') = 'CREDIT'
   AND payee_vpa IS NOT NULL
   -- The guess only ran for banker-tagged alerts, so an untagged row's VPA was genuinely
   -- stated and is also load-bearing for that row's attribution. Never touch those.
   AND merchant_id IS NOT NULL
   -- Spare anything the capture really did name: if the stored VPA appears in the alert's own
   -- text or detail block, the payment stated it and it is a fact, not a guess.
   AND position(lower(payee_vpa) in lower(COALESCE(raw,''))) = 0
   AND position(lower(payee_vpa) in lower(COALESCE(details::text,''))) = 0
   AND position(lower(payee_vpa) in lower(COALESCE(narration,''))) = 0;
