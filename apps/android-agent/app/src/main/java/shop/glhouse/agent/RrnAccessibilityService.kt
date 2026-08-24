package shop.glhouse.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Captures full UPI RRNs from Paytm Business. Ported verbatim from the proven
 * standalone "RRN Extractor" engine; the only Katana-specific change is that
 * auto-capture reads [Prefs.autoCapture] and each captured RRN is forwarded to
 * the Katana orchestrator via [RrnStore] (→ AlertUploader → /api/v1/txn-alert)
 * instead of a Google Sheet.
 *
 * Manual mode (default): when the user opens a payment's detail screen, the
 * service scrolls to the RRN, screenshots, finds the blue "Copy" link by colour,
 * taps it (a real gesture — a synthetic click doesn't trigger the WebView copy),
 * then [ClipReaderActivity] reads + validates + forwards the clipboard value.
 *
 * Auto mode (toggle in the app): while Paytm's payments LIST is on screen, the
 * service watches for new transaction rows and, for each new one, opens it →
 * captures the RRN → presses Back to return to the list.
 */
class RrnAccessibilityService : AccessibilityService() {

    private val TAG = "RRNCAP"
    private val main = Handler(Looper.getMainLooper())

    private val maskedRrn = Regex("(\\d{3})[.\\u2026]+(\\d{6})")
    private val amountRx = Regex("₹\\s?[0-9][0-9,]*")
    private val timeRx = Regex("\\d{1,2}:\\d{2}\\s?[AP]M", RegexOption.IGNORE_CASE)
    // Matches both the Home header ("8 Payment, Today") and the list header
    // ("211 Payments") — "Payment" is a prefix of both.
    private val countRx = Regex("([0-9][0-9,]*)\\s+Payment", RegexOption.IGNORE_CASE)
    // The home screen's summary row, which opens the full payments list. The ", Today" suffix is
    // what separates it from the full list's own "… from N Payments" header.
    private val homeSummaryRx = Regex("from\\s+[0-9][0-9,]*\\s+Payment,\\s*Today", RegexOption.IGNORE_CASE)
    // THE SCREEN THE SWEEP MUST NEVER DRIVE. Paytm's payments list and its bank-settlement
    // screen are two tabs of ONE activity (PaymentsSettlementsActivity), so returning from a
    // payment detail can land on the settlement tab without any navigation the sweep can see.
    // That tab carries "Settle Now" — a button that moves real money — and on 2026-08-21 a
    // backfill spent 58 consecutive scrolls sitting on it. A sweep that cannot see payment rows
    // has no business scrolling; recognising this screen by name is what stops it.
    // MATCH ONLY WHAT IS UNIQUE TO THAT TAB. "Settle Now" also sits on every payment DETAIL
    // screen ("Want to instantly settle the collected amount?"), and "Bank Settlements" is the
    // label of the tab NEXT to Payments — so it is on screen while the payments list is showing.
    // Matching either ended healthy sweeps instantly. These two strings appear on the settlement
    // tab and nowhere else.
    // PHONEPE FOR BUSINESS — the whole engine, essentially.
    //
    // Its History list prints the reference on every row: "UTR: 660060216086 | QR". That is the
    // same 12-digit UPI RRN Katana stores everywhere else, and it is on the LIST — so unlike
    // Paytm there is nothing to open, no masked reference to expand, no "Copy" link to find by
    // geometry, no clipboard to read, and no BACK press to get wrong. The row cannot be tapped
    // into a screen carrying "Settle Now" because the row is never tapped at all.
    private val phonepeUtrRx = Regex("UTR:\\s*(\\d{12})", RegexOption.IGNORE_CASE)
    // The tail of the same line states how the money came in: "UTR: 660060216086 | QR".
    private val phonepeModeRx = Regex("UTR:\\s*\\d{12}\\s*\\|\\s*(.+)$", RegexOption.IGNORE_CASE)
    // "₹205", "₹1,400", "₹14,800" — the row's own amount, always immediately above the UTR line.
    private val phonepeAmountRx = Regex("^₹\\s?[0-9][0-9,]*(\\.[0-9]{1,2})?$")
    // "05:03PM" — the row's time marker, and the top of the row when scanning backwards.
    private val phonepeTimeRx = Regex("^[0-9]{1,2}:[0-9]{2}\\s?[AP]M$", RegexOption.IGNORE_CASE)

    private val settlementScreenRx =
        Regex("Previous Settlements|Available for settlement", RegexOption.IGNORE_CASE)

    // CONTROLS THAT MOVE MONEY. THE AGENT PRESSES NONE OF THEM, EVER.
    //
    // Settling and refunding are the merchant's decisions, taken by hand in Paytm. This agent
    // exists to READ an RRN off the screen; it has no business authorising a transfer, and no
    // capture is worth the risk of one. The danger is not that it decides to — it is that it
    // taps a coordinate the layout has moved a button under. That is exactly what happened on
    // 2026-08-21: the Copy link was believed to be at (919,1843) and Paytm's "Settle Now"
    // occupies [717,1796][993,1892] — its precise centre. Eighteen payments produced no RRN and
    // eighteen presses of a button that moves money.
    //
    // Geometry fixes (matching Copy by its row) make that mis-aim unlikely. This makes it
    // impossible: every tap and every click is checked against what is actually under it first,
    // so no future layout change, mis-read or stale coordinate can press one of these.
    private val moneyControlRx = Regex(
        "^\\s*(settle now|settle|instantly settle|refund to customer|refund|issue refund|" +
            "proceed to refund|confirm refund|transfer now|withdraw)\\s*$",
        RegexOption.IGNORE_CASE)

    /**
     * The label of a money-moving control lying under this screen point, or null when the point
     * is safe to tap. Bounds-based on purpose: what matters is what the finger would LAND on,
     * not what the tree says we intended to hit.
     */
    private fun moneyControlAt(x: Float, y: Float): String? {
        val root = rootInActiveWindow ?: return null
        val all = ArrayList<Pair<String, AccessibilityNodeInfo>>()
        flattenAll(root, all)
        val px = x.toInt(); val py = y.toInt()
        for ((text, n) in all) {
            val t = text.trim()
            if (t.isEmpty() || !moneyControlRx.containsMatchIn(t)) continue
            val r = Rect().also { n.getBoundsInScreen(it) }
            if (r.width() > 0 && r.height() > 0 && r.contains(px, py)) return t
        }
        return null
    }

    /** True when this node — or the clickable ancestor we would press — is a money control. */
    private fun isMoneyControl(n: AccessibilityNodeInfo): Boolean {
        val t = (n.text ?: n.contentDescription ?: "").toString().trim()
        return t.isNotEmpty() && moneyControlRx.containsMatchIn(t)
    }
    // Row keys seen at the previous scroll, and how many scrolls in a row have produced exactly
    // the same ones. A WebView list that has stopped advancing reports an unchanged row set, and
    // scrolling it again cannot do anything except waste the budget next to a money control.
    private var lastRowKeys: Set<String> = emptySet()
    private var sweepStallScrolls = 0

    // ---- PhonePe list sweep ----
    private var ppSweeping = false
    private var ppScrolls = 0
    private var ppDryScreens = 0
    private var ppRewinding = 0
    private var ppLastSweep = 0L
    /** This sweep was asked for as a backfill: walk the whole list, not just the fresh top. */
    private var ppDeep = false

    // ---- detail-capture state ----
    private val attempts = HashMap<String, Int>()
    // How many times we have scrolled a payment's detail screen looking for its RRN Copy link.
    // Paytm renders that block below the fold, so it has to be scrolled to before it exists as a
    // laid-out node — and a screen that never yields one must give up rather than scroll forever.
    private val scrollsForCopy = HashMap<String, Int>()
    private var detailBusyUntil = 0L

    // ---- auto-navigation state ----
    private var baselineDone = false
    private var handledCount = 0
    private var sweeping = false
    /**
     * Rows already visited in THIS sweep, keyed by their own text (time, amount, payer).
     *
     * Position was the old key, and position is not stable across a scroll — which is why the
     * sweep could never scroll. A key that travels with the row can: the sweep walks the visible
     * rows, scrolls, and keeps walking, without re-opening what it has just seen.
     */
    private val sweptKeys = HashSet<String>()
    private var sweepScrolls = 0
    private var lastOpenResult = R_UNKNOWN
    /** The list row the sweep is currently inside, so its outcome can be recorded against it. */
    private var openingRowKey: String? = null
    private var autoNavigating = false      // we auto-opened the current detail
    private var backScheduled = false
    private var detailReached = false       // the auto-opened detail actually appeared
    private var openGen = 0                  // invalidates stale watchdog timers
    private var openRetries = 0
    private var backAttempts = 0            // how many BACKs we've pressed this return
    private var waitChecks = 0              // transitional re-checks while returning

    // ---- GPay auto-navigation state ----
    //
    // Deliberately NOT shared with the Paytm sweep above. Only one app is ever in the
    // foreground so the two can't literally interleave, but a sweep that is paused
    // mid-flight (screen off, app switched) leaves its state set; sharing the fields would
    // let a stale Paytm sweep position steer a GPay sweep into tapping the wrong rows.
    private var gpaySweeping = false
    private var gpaySweepPos = 0
    private var gpayOpenGen = 0             // invalidates stale watchdog timers
    private var gpayOpenRetries = 0
    private var gpayAutoNavigating = false  // we auto-opened the current detail
    private var gpayDetailReached = false
    private var gpayBackScheduled = false
    private var gpayLastResult = R_UNKNOWN
    private var gpayBackAttempts = 0
    private var gpayWaitChecks = 0
    private var gpayRowRetried = false      // this row already got its second chance
    private var lastGpaySweep = 0L
    private var lastGpayDump = 0L
    private var lastGpayNav = 0L
    private var lastGpayRefresh = 0L
    // Detail being assembled across scrolls (Flutter only exposes rendered widgets, so a
    // detail screen has to be read in more than one pass — see collectGpayDetail).
    private var gpayDetailRrn: String? = null
    private val gpayDetailFields = HashMap<String, String>()
    private var gpayDetailScrolls = 0
    private var gpayDetailGen = 0           // invalidates the stale safety-net finalize
    private var gpaySweepStarted = 0L       // for the stuck-sweep guard below
    private var gpaySettleUntil = 0L        // don't tap while a refreshed list animates in

    companion object {
        private const val MAX_ATTEMPTS = 4
        private const val MAX_COPY_SCROLLS = 6
        // How long to wait between position re-reads, and how many times to look, before the
        // Copy link is considered to have stopped moving.
        private const val SETTLE_MS = 260L
        private const val SETTLE_TRIES = 4
        // Long enough for a swipe to dispatch, land and re-lay-out the detail before the next
        // accessibility event is allowed to act on it.
        private const val SCROLL_WAIT_MS = 1200L
        // THE SAME WAIT, BUT FOR THE DETAIL SCREEN, WHICH IS NOT THE LIST.
        //
        // 1200ms was measured on the payments list: a long, lazily-loaded WebView that fetches
        // the next screenful after the gesture ends. A payment detail is a short, already-loaded
        // page — the RRN block is below the fold, not un-fetched — so it re-lays-out in a
        // fraction of that. Since EVERY capture scrolls this screen (Paytm always renders RRN
        // below the fold), the difference is paid on every single payment: at ~5 payments a
        // minute, the old wait alone spent over a minute an hour doing nothing.
        private const val COPY_SCROLL_WAIT_MS = 650L
        // How many times to re-read the detail after a scroll before giving the payment up.
        //
        // WHY A RETRY AT ALL. The re-read after a scroll used to be single-shot: if that one look
        // did not find the "RRN" label, the capture went silent and the payment sat holding the
        // queue slot until CAPTURE_DEADLINE_MS expired. Live on 2026-08-21 that silence was the
        // dominant cost — captures themselves take about 2.4s, yet payments were landing 18-22s
        // apart, the difference being stalls of 9s and 21s spent waiting on a deadline for a
        // screen that simply had not finished re-laying-out. Looking twice more costs 700ms and
        // removes an 8-second stall.
        private const val COPY_REREAD_TRIES = 3
        private const val COPY_REREAD_MS = 350L
        private const val COPY_SETTLE_MS = 450L
        private const val BUSY_MS = 4500L
        private const val COPY_X_FRAC = 0.855f
        private const val COPY_BAND_FRAC = 0.06f
        // Auto mode timings.
        private const val AUTO_DETAIL_BACK_MS = 2600L // return to list this long after opening a detail
        // How far down the list one sweep may scroll. A BURST PUSHES ITS OWN BACKLOG BELOW THE
        // FOLD: payments arriving faster than they can be opened drive the un-captured ones off
        // screen, and a sweep that only ever read the visible rows could never go and get them.
        private const val MAX_SWEEP_SCROLLS = 4
        // Enough to walk a full trading day of payments when backfilling after an outage.
        // Paytm's list shows about three payments per screen, so a full trading day of 200+
        // needs on the order of seventy scrolls; this leaves headroom above that.
        private const val DEEP_SWEEP_SCROLLS = 120
        // How many consecutive scrolls may report an unchanged set of rows before the list is
        // declared stuck. Four tolerates a slow lazy-load or two; sitting through 120 does not.
        private const val MAX_STALL_SCROLLS = 4
        // PHONEPE LIST SWEEP. A passive read only ever sees the rows currently rendered — about
        // six. Payments arriving in a burst are pushed below the fold before the next
        // accessibility event and are then never read again: on 2026-08-22 PhonePe held 392
        // payments and Katana held 202, and scrolling the list by hand recovered ten in twenty
        // seconds. So the engine walks the list itself. It is cheap — a flatten and a regex per
        // screen, no row is ever opened — which is why it can afford to run often.
        private const val PP_SWEEP_INTERVAL_MS = 25_000L
        // HOW LONG TO WAIT FOR A REFRESH TO COME BACK. The pull fires a network fetch, so the
        // new rows are not on screen when the gesture completes — reading immediately re-reads
        // the same stale list and concludes, wrongly, that nothing arrived.
        private const val PP_REFRESH_WAIT_MS = 2_500L
        // The ROUTINE sweep only has to reach rows a burst pushed below the fold seconds ago, so
        // it stays shallow and cheap — it runs every 25 seconds all day.
        private const val PP_MAX_SCROLLS = 12
        // A BACKFILL HAS TO REACH THIS MORNING, AND THE LIST IS LAZY-LOADED. Measured
        // 2026-08-22: thirty swipes walked back only about eighty-five minutes of payments,
        // because each swipe advances less than a screen while PhonePe fetches the next chunk.
        // A full trading day therefore needs scrolls in the hundreds, which at ~0.9s each is a
        // few minutes — the right trade for a recovery pass that runs on request, and the reason
        // it is NOT the budget the routine sweep uses.
        private const val PP_DEEP_SCROLLS = 400
        // Consecutive screens yielding nothing new before the sweep is considered caught up.
        // Two, because one screen can legitimately repeat while the WebView re-lays-out.
        private const val PP_DRY_SCREENS = 2
        // How long the list is given to render after a swipe before its rows are read.
        private const val PP_SCROLL_WAIT_MS = 700L
        // How long the payments-list WebView is given to re-lay-out after a swipe before its
        // rows are read. Deliberately generous: reading early looks exactly like a stalled list,
        // and the cost of waiting is a second per screenful while the cost of guessing wrong is
        // abandoning the backfill (2026-08-22: seven rows of 478).
        private const val LIST_RERENDER_MS = 1600L
        // Longer than the sweep's own return: a bridge-opened Paytm detail has to read the masked
        // reference, tap Copy and let the clipboard reader run before it is safe to press BACK.
        private const val BRIDGE_BACK_MS = 5000L
        // Result of the last auto-opened detail (new = captured, old = boundary).
        private const val R_UNKNOWN = 0
        private const val R_NEW = 1
        private const val R_OLD = 2

        // GPay auto-drive timings. The sweep interval is deliberately long: unlike Airtel
        // (whose list carries the RRN and needs only a refresh tap) every GPay row costs an
        // open + read + back, so sweeping tightly would keep the merchant's screen
        // permanently hijacked.
        private const val GPAY_SWEEP_INTERVAL_MS = 20_000L
        // Watchdog for "the row tap never opened a detail". Generous on purpose: a budget
        // handset can take several seconds to render a Flutter detail screen, and a tight
        // deadline would skip rows that were merely still loading — silently losing RRNs on
        // exactly the cheap phones most merchants actually use. A row is retried once at
        // double this before being given up on.
        private const val GPAY_DETAIL_WAIT_MS = 6000L
        private const val GPAY_MAX_ROWS = 15            // rows opened per sweep pass
        // How often a parked capture phone refreshes the list on its own, with no push to
        // prompt it. Slow enough to leave the screen usable between refreshes, fast enough
        // that a payment is picked up within about half a minute.
        private const val GPAY_IDLE_REFRESH_MS = 30_000L
        // How long the refreshed list is given to stop moving before we tap into it.
        private const val GPAY_SETTLE_MS = 2500L
        // Keep clear of the bottom nav / gesture strip: a tap there navigates the phone away.
        private const val GPAY_EDGE_MARGIN_PX = 260

        // Set by CommandPoller when the dashboard raises a "Get RRN" request: forces the
        // next payments-list pass to re-sweep the visible rows (retrying any whose RRN we
        // don't yet have) instead of idling until a new payment arrives. Cleared on use.
        @Volatile private var forceResweep = false
        fun requestResweep() { forceResweep = true }

        /**
         * A DEEP SWEEP WALKS THE WHOLE LIST, not just the part above the newest capture.
         *
         * The ordinary sweep stops after STOP_AFTER_OLD already-captured rows because that is
         * reliably where "new payments" end — every older row below it was captured on the day it
         * arrived. That assumption fails after an outage: on 2026-08-21 the Copy tap was landing on
         * the wrong control, so a whole day of payments went uncaptured and sat BELOW the handful
         * captured after the fix. The boundary heuristic then stopped the sweep five rows in and
         * declared the backlog old.
         *
         * So an explicitly requested re-sweep ignores the boundary and scrolls far deeper. It is
         * slower and re-opens rows it already holds (RrnStore dedupes them, costing ~2s each), and
         * that is the correct trade when the alternative is leaving captured money unreported.
         */
        @Volatile private var deepSweep = false
        @Volatile private var openedFullList = false
        // True for the lifetime of one sweep that was started as a backfill.
        @Volatile private var sweepIsDeep = false
        fun requestDeepSweep() {
            deepSweep = true; forceResweep = true; openedFullList = false
            // The same request arms PhonePe, whose list has its own below-the-fold backlog.
            instance?.let { it.ppDeep = true; it.ppLastSweep = 0L; it.ppSweeping = false }
        }

        const val GPAY_PKG = "com.google.android.apps.nbu.paisa.merchant"
        @Volatile private var lastGpayLaunch = 0L
        // The list is stale at the moment the push arrives, so a notification-armed sweep
        // must refresh it first — see gpayTryRefresh.
        @Volatile private var gpayRefreshPending = false

        /**
         * Go and fetch the RRN for a GPay payment we just heard about.
         *
         * WHY THIS EXISTS. The accessibility engine is purely reactive: it can only read what
         * is on screen, so on its own it captures an RRN only if the merchant happens to be
         * sitting on GPay's transactions list at the time. Put the phone down and the RRN is
         * simply never collected — which is exactly what happened to a live ₹2 payment on
         * 2026-08-14 (the notification landed, no ACCESSIBILITY row ever followed).
         *
         * The notification channel, by contrast, fires for EVERY payment. So we use the
         * reliable signal to drive the unreliable one: a GPay credit push brings GPay to the
         * front and arms an immediate sweep, which reads the RRN off the detail and returns.
         *
         * Throttled, and gated on auto-capture — this deliberately steals the foreground, so
         * it is only ever appropriate on a dedicated capture phone, which is what auto-capture
         * already signals.
         */
        // Payments waiting to be opened and read, one at a time. There is a single screen, so
        // captures are inherently serial — but they must QUEUE rather than be dropped.
        // Each queued capture remembers WHICH APP it came from: the queue serves Paytm and GPay
        // alike, and only GPay needs its list refreshed afterwards.
        private val pendingCaptures = ArrayDeque<Pair<PendingIntent, String>>()
        @Volatile private var captureBusy = false
        /**
         * Which capture currently holds the slot. Every release stamps a new generation, so a
         * timer armed for an EARLIER payment can no longer end a LATER one. Harmless while the
         * only release was the deadline itself; essential now that a capture finishes as soon as
         * its RRN is read — payment #2 would otherwise be cut off nine seconds after #1 started.
         */
        @Volatile private var captureGen = 0
        /** The running service, so the queue can drive the screen between payments. */
        @Volatile private var instance: RrnAccessibilityService? = null
        /** Pause between one payment being finished with and the next being opened. */
        // Pause after the LAST queued payment, while the screen returns to the list. A backlog
        // uses 350ms instead (the next payment's own intent navigates, so nothing must settle).
        // 900ms was chosen before Paytm had a completion signal at all; with onPaytmCaptureDone
        // leaving the detail the moment the clipboard is read, the screen is already still.
        private const val CAPTURE_SETTLE_MS = 550L
        /** When a notification intent last opened a payment detail; 0 = never. */
        @Volatile private var bridgeOpenedAt = 0L
        /** A detail opened by us stays "ours" this long — beyond it, assume the merchant drove. */
        private const val BRIDGE_OWNED_MS = 60_000L
        private val pump = Handler(Looper.getMainLooper())
        // Only a backstop now that both apps report completion — long enough that a slow phone
        // rendering a detail screen is not cut off, short enough that one unreadable payment
        // cannot stall a burst.
        private const val CAPTURE_DEADLINE_MS = 8_000L   // give up on one payment, move on
        // Bound, not a policy: at roughly three seconds a payment this is over ten minutes of
        // backlog, and anything beyond it is recovered by the list sweep instead.
        private const val CAPTURE_QUEUE_MAX = 200        // bound: never grow without limit

        /**
         * Queue a payment for capture, using the notification's own intent so we land
         * directly on THAT payment's detail screen.
         *
         * Replaces a 15-second throttle that silently DROPPED every payment arriving inside
         * the window — politeness on a quiet phone, but a hard ceiling of 4 payments/minute
         * on a busy one, no matter how fast the capture itself is (measured at ~2s end to
         * end). Queuing keeps the same one-at-a-time behaviour on screen while letting a
         * burst drain back-to-back instead of being thrown away.
         */
        /**
         * Queue a payment for capture from a credit push, for EITHER payment app.
         *
         * Paytm was previously left out, and the consequence was exactly what the merchant
         * reported (2026-08-17): a ₹1 payment landed, the credit was forwarded, but the RRN only
         * appeared after they opened the payment BY HAND. The engine reads Paytm perfectly — the
         * live log shows masked RRN → Copy → clipboard → upload in under 4 seconds — but nothing
         * ever told it to look. Its list does not live-update, so the only way it noticed a new
         * payment was an accessibility event from someone touching the app.
         *
         * Airtel gets there by re-tapping its own refresh, GPay by this queue. Now Paytm uses the
         * queue too: the notification's own intent opens that payment, and `forceResweep` makes
         * the list sweep again in case the intent lands somewhere else.
         */
        fun enqueueCapture(ctx: Context, intent: PendingIntent?, app: String) {
            if (!Prefs.enabled(ctx)) return
            if (!Prefs.autoCapture(ctx) || !Prefs.captureAppOn(ctx, app)) return
            if (intent == null) { requestAppCapture(ctx, app); return }   // no intent: sweep instead
            synchronized(pendingCaptures) {
                if (pendingCaptures.size >= CAPTURE_QUEUE_MAX) {
                    // Counted, not just logged: a dropped capture is a payment whose RRN nobody
                    // will ever go and fetch, and it must be visible on the dashboard rather than
                    // inferred from a gap. The list sweep is the backstop for these.
                    Log.w("RRNCAP", "capture queue full; dropping oldest")
                    Prefs.bump(ctx, "capture_drop")
                    pendingCaptures.removeFirstOrNull()
                }
                pendingCaptures.addLast(intent to app)
            }
            pumpCaptures(ctx)
        }

        /** Start the next queued capture if nothing is in flight. */
        private fun pumpCaptures(ctx: Context) {
            if (captureBusy) return
            val (next, app) = synchronized(pendingCaptures) { pendingCaptures.removeFirstOrNull() } ?: return
            captureBusy = true
            val gen = ++captureGen
            // Whatever the previous payment left behind stops applying now: its return timer must
            // not press BACK out of the payment we are about to open, and its per-screen busy gate
            // must not delay reading this one. Posted to the main thread because a push arrives on
            // a binder thread, and this state is otherwise only ever touched from the engine's own
            // thread; the post still lands before the new screen's first accessibility event.
            instance?.let { svc -> pump.post { svc.onNewCaptureStarting() } }
            forceResweep = true
            // Stamped so the engine knows this detail screen was opened by US, not by the
            // merchant — and must therefore be left again once the RRN is read.
            bridgeOpenedAt = System.currentTimeMillis()
            // GPay's transactions list is a static search result that must be re-run; Paytm's
            // sweep re-reads whatever the list shows, so it needs no refresh flag.
            if (app == Prefs.APP_GPAY) gpayRefreshPending = true
            val ok = try { next.send(); true } catch (e: Exception) {
                Log.w("RRNCAP", "${app.lowercase()}: queued intent failed: ${e.javaClass.simpleName}"); false
            }
            if (!ok) requestAppCapture(ctx, app)
            // Never let one unreadable payment wedge the queue — but only ever end the payment
            // this timer was armed for (see captureGen).
            pump.postDelayed({
                if (captureBusy && gen == captureGen) {
                    Log.w("RRNCAP", "capture deadline reached; moving on to the next payment")
                    Prefs.bump(ctx, "capture_timeout")
                    captureBusy = false; captureGen++
                    pumpCaptures(ctx)
                }
            }, CAPTURE_DEADLINE_MS)
        }

        /** How many payments are still waiting to be opened. */
        fun pendingCaptureCount(): Int = synchronized(pendingCaptures) { pendingCaptures.size }

        /** A capture finished (or was skipped as already-held) — release the queue. */
        fun onCaptureFinished(ctx: Context, settleMs: Long = 250L) {
            if (!captureBusy) return
            captureBusy = false
            captureGen++
            pump.postDelayed({ pumpCaptures(ctx) }, settleMs)   // let the screen settle between payments
        }

        /**
         * A Paytm payment is finished with — its RRN is captured, or we already held it, or the
         * screen could not be read.
         *
         * WHY THIS EXISTS. Paytm never had a completion signal at all: only GPay called
         * [onCaptureFinished], so every queued Paytm payment held the capture slot until the
         * nine-second deadline expired — a hard ceiling of under seven payments a minute, no
         * matter that a real capture takes about three seconds end to end. On a merchant doing
         * live volume (2026-08-18) that is precisely the shape of the loss reported: the early
         * payments captured, the rest arriving faster than the queue could drain, and the
         * remainder opened by hand.
         *
         * Reading the clipboard is the moment the payment is done with, so it says so here: the
         * detail screen is left immediately rather than on a fixed five-second timer, and the
         * next payment starts about three seconds after this one — roughly three times the
         * throughput, with no change to what is captured.
         */
        fun onPaytmCaptureDone(ctx: Context) {
            instance?.leavePaytmDetailNow()
            // A backlog gets the short pause: nothing has to settle, because the next payment's
            // own intent navigates the screen rather than a BACK press. The pause is for the LAST
            // payment, which does return to the list.
            onCaptureFinished(ctx, if (pendingCaptureCount() > 0) 350L else CAPTURE_SETTLE_MS)
        }

        /** Open the payment app and re-sweep — the fallback when a push carries no intent. */
        fun requestAppCapture(ctx: Context, app: String) {
            if (!Prefs.enabled(ctx)) return
            if (!Prefs.autoCapture(ctx) || !Prefs.captureAppOn(ctx, app)) return
            val now = System.currentTimeMillis()
            if (now - lastGpayLaunch < 15_000L) return   // a burst of pushes = one trip
            lastGpayLaunch = now
            forceResweep = true
            if (app == Prefs.APP_GPAY) gpayRefreshPending = true
            // Paytm ships under two package names; open whichever this phone actually has.
            val pkg = if (app == Prefs.APP_GPAY) GPAY_PKG
                else listOf("com.paytm.business", "net.one97.paytm.merchant")
                    .firstOrNull { runCatching { ctx.packageManager.getLaunchIntentForPackage(it) }.getOrNull() != null }
                    ?: "com.paytm.business"
            try {
                val i = ctx.packageManager.getLaunchIntentForPackage(pkg)
                if (i == null) { Log.w("RRNCAP", "$pkg not installed; cannot auto-open"); return }
                // Background activity launch is restricted on Android 14+; it is permitted for
                // an app holding SYSTEM_ALERT_WINDOW, which this agent already requires for
                // ClipReaderActivity. If the OS still blocks it the sweep simply doesn't run —
                // the notification row is already uploaded, so no payment is lost either way.
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(i)
                Log.d("RRNCAP", "gpay: opened by credit notification -> sweep armed")
            } catch (e: Exception) {
                Log.w("RRNCAP", "gpay: auto-open failed: ${e.message}")
            }
        }
    }

    private fun autoModeEnabled(): Boolean = Prefs.autoCapture(this)

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        RrnStore.init(applicationContext)
        // Set the watched package list at RUNTIME. Android caches the packageNames from the
        // accessibility XML at first bind and does NOT reload it on app update, so a package
        // added to the XML (e.g. GPay) never receives events until the service is toggled
        // off/on. Setting it here guarantees the current list takes effect on every connect.
        try {
            serviceInfo = (serviceInfo ?: AccessibilityServiceInfo()).apply {
                // Set ALL delivery-critical fields explicitly — only mutating packageNames can
                // leave eventTypes cleared on some ROMs, silently stopping event delivery.
                eventTypes = AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
                    AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                    AccessibilityEvent.TYPE_VIEW_SCROLLED
                feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
                flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
                    AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
                    AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                notificationTimeout = 100
                packageNames = arrayOf(
                    "net.one97.paytm.merchant", "com.paytm.business", "com.apbl.merchant",
                    "com.google.android.apps.nbu.paisa.merchant",
                    // PhonePe for Business. Adding it to accessibility_config.xml alone changed
                    // nothing — exactly the trap this block exists for: the XML list is cached at
                    // first bind, so on an already-installed agent PhonePe's screens delivered no
                    // events at all and the engine looked broken when it had simply never been
                    // called (2026-08-22).
                    "com.phonepe.app.business",
                )
            }
        } catch (e: Exception) { Log.w(TAG, "setServiceInfo failed: ${e.message}") }
        Log.d(TAG, "service connected (sdk=${Build.VERSION.SDK_INT}); watching ${serviceInfo?.packageNames?.joinToString()}")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val root = rootInActiveWindow ?: return
        // Only run the engines for the payment apps this merchant selected in the UI —
        // a Paytm-only phone never reacts to Airtel screens and vice versa.
        when (root.packageName?.toString()) {
            // BOTH Paytm-for-Business package names route to the same engine. The service has
            // always WATCHED net.one97.paytm.merchant (it is in accessibility_config.xml and in
            // the runtime packageNames), but nothing handled it — so on a phone carrying that
            // build, events arrived and were dropped, and capture would have looked dead for no
            // visible reason. The screens are the same, so the same engine reads them.
            "com.paytm.business", "net.one97.paytm.merchant" ->
                if (Prefs.captureAppOn(this, Prefs.APP_PAYTM)) handlePaytm(root)
            "com.apbl.merchant"  -> if (Prefs.captureAppOn(this, Prefs.APP_AIRTEL)) handleAirtel(root)   // Airtel Payments Bank Merchant
            "com.google.android.apps.nbu.paisa.merchant" -> if (Prefs.captureAppOn(this, Prefs.APP_GPAY)) handleGpay(root)  // Google Pay for Business
            "com.phonepe.app.business" -> if (Prefs.captureAppOn(this, Prefs.APP_PHONEPE)) handlePhonePe(root)  // PhonePe for Business
            else -> return
        }
    }

    private fun handlePaytm(root: AccessibilityNodeInfo) {
        val autoMode = autoModeEnabled()
        if (!autoMode) { baselineDone = false; autoNavigating = false }

        val ordered = ArrayList<Pair<String, AccessibilityNodeInfo>>()
        flatten(root, ordered)
        val texts = ordered.map { it.first }

        if (texts.any { it.equals("RRN", true) }) {
            handleDetail(ordered, texts, autoMode)
        } else if (autoMode) {
            handleList(ordered)
        }
    }

    // ------------------------------------------------------------------ Airtel
    //
    // Airtel Payments Bank Merchant (com.apbl.merchant) shows the FULL 12-digit UPI RRN
    // unmasked, right on its reports/transactions list — no tap/copy needed. Incoming UPI
    // credits carry an exactly-12-digit RRN; bank settlements carry 15-digit refs, so a
    // strict 12-digit match captures real payments and skips settlements. Each visible RRN
    // is paired with the nearest amount and payer name by on-screen vertical position.
    // Passive read — no navigation — so it runs whenever the reports screen is visible.

    // Capture ONLY the 12-digit UPI RRN (on "successful" payment rows). The 15-digit
    // Airtel settlement reference used to be captured too and then hidden on the
    // dashboard — dead weight. v2.33: skip it at the source (real payments are always the
    // 12-digit UPI RRN; settlements are 15-digit).
    // How many familiar rows in a row end a sweep. Three was enough for a quiet list, where the
    // only stale rows are the one or two at the top that re-rendered late. Under real volume the
    // captured and un-captured rows interleave — the queue opens payments out of list order — so
    // three familiar rows no longer means the new ones are behind us.
    private val STOP_AFTER_OLD = 5
    private val airtelRrn = Regex("(?<!\\d)\\d{12}(?!\\d)")
    private val airtelAmount = Regex("₹\\s?[0-9][0-9,]*(?:\\.[0-9]{1,2})?")
    private val airtelName = Regex("^[A-Za-z][A-Za-z .]{2,39}$")
    private val airtelStop = setOf(
        "reports", "business", "recharge", "select date", "from date", "to date", "search",
        "total amount collected", "no. of payments", "successful", "settlement", "charges & gst",
        "download", "share now", "home", "my qr", "get loan", "settlements", "view all transactions",
        "today's collection", "last settlement", "soundbox", "payments bank", "nilam",
    )
    private var lastAirtelDump = 0L      // throttle the debug dump
    private var lastAirtelRefresh = 0L   // throttle the hands-free "search" re-tap
    /** Consecutive already-captured rows in this sweep; see onReturned. */
    private var oldStreak = 0
    /** True while a bridge-opened detail is queued to be closed; see returnFromDetail. */
    private var bridgeBackScheduled = false
    /**
     * Which bridge-opened payment the pending return belongs to.
     *
     * The return used to be a bare five-second timer. That was safe only because the next payment
     * could not start for nine seconds; now that a capture ends as soon as its RRN is read, the
     * timer left over from payment #1 would fire while payment #2 is on screen and press BACK out
     * of a capture in progress. Every scheduled return carries the generation it was armed for.
     */
    private var bridgeGen = 0

    // Click a node via its nearest clickable ancestor (ACTION_CLICK), falling back to a
    // real tap gesture at its centre. Used to re-run Airtel's "search" for hands-free refresh.
    private fun clickNode(node: AccessibilityNodeInfo): Boolean {
        if (isMoneyControl(node)) {
            Log.w(TAG, "REFUSING to click a money control: \"${(node.text ?: node.contentDescription)}\"")
            return false
        }
        var n: AccessibilityNodeInfo? = node
        var depth = 0
        while (n != null && depth < 6) {
            if (n.isClickable) {
                // The ancestor is what actually receives the click, so it is the thing that has
                // to be safe — a harmless-looking row inside a "Settle Now" card would otherwise
                // press the card.
                if (isMoneyControl(n)) {
                    Log.w(TAG, "REFUSING to click: the clickable ancestor is a money control")
                    return false
                }
                n.performAction(AccessibilityNodeInfo.ACTION_CLICK); return true
            }
            n = n.parent; depth++
        }
        val r = Rect().also { node.getBoundsInScreen(it) }
        if (r.width() > 0 && r.height() > 0) { tap(r.exactCenterX(), r.exactCenterY()); return true }
        return false
    }

    /**
     * PhonePe for Business — a PASSIVE read of the History list. No gestures, ever.
     *
     * Every row is five consecutive nodes in traversal order:
     *
     *     "05:03PM"  "•"  "Arvind Das"  "₹205"  "UTR: 660060216086 | QR"
     *
     * so the UTR line anchors the row and everything else is found by walking backwards to the
     * time marker. Rows already held are skipped by RrnStore, which is what keeps this cheap
     * enough to run on every content event: a screenful re-read costs nothing but a flatten.
     *
     * WHY THIS ENGINE IS THE ONE TO TRUST. Paytm hides the RRN behind a detail screen, so its
     * engine must open each payment, scroll to a block below the fold, identify the right "Copy"
     * among three, tap a coordinate, read the clipboard and navigate back — six chances to fail
     * per payment, one of which (a mis-aimed tap) pressed "Settle Now" eighteen times on
     * 2026-08-21. PhonePe prints the reference on the row. Nothing is driven, so nothing can be
     * driven wrong, and capture no longer depends on the phone winning a race against a burst.
     */
    /**
     * "05:03PM" -> "2026-08-22T17:03:00+05:30", using the phone's own clock for the date.
     *
     * The list states a time and nothing else, so the date has to come from context: these rows
     * are today's. The guard matters — a sweep deep enough to reach yesterday would otherwise
     * stamp yesterday's evening payments as today's future. Anything landing more than ten
     * minutes ahead of now is therefore read as the previous day.
     */
    private fun phonepeEventTime(paidAt: String): String? {
        val m = Regex("^([0-9]{1,2}):([0-9]{2})\\s?([AP]M)$", RegexOption.IGNORE_CASE)
            .find(paidAt.trim()) ?: return null
        var hour = m.groupValues[1].toIntOrNull()?.rem(12) ?: return null
        if (m.groupValues[3].uppercase(java.util.Locale.US) == "PM") hour += 12
        val minute = m.groupValues[2].toIntOrNull() ?: return null
        val cal = java.util.Calendar.getInstance().apply {
            set(java.util.Calendar.HOUR_OF_DAY, hour)
            set(java.util.Calendar.MINUTE, minute)
            set(java.util.Calendar.SECOND, 0)
            set(java.util.Calendar.MILLISECOND, 0)
        }
        if (cal.timeInMillis > System.currentTimeMillis() + 10 * 60_000L)
            cal.add(java.util.Calendar.DAY_OF_MONTH, -1)
        return runCatching {
            java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", java.util.Locale.US).format(cal.time)
        }.getOrNull()
    }

    private fun handlePhonePe(root: AccessibilityNodeInfo) {
        if (!Prefs.enabled(this)) return
        val ordered = ArrayList<Pair<String, AccessibilityNodeInfo>>()
        flatten(root, ordered)

        var captured = 0
        for (i in ordered.indices) {
            val rrn = phonepeUtrRx.find(ordered[i].first)?.groupValues?.get(1) ?: continue
            if (RrnStore.isMaskedCaptured(rrn)) continue   // already held — do not re-upload

            // Walk back to this row's time marker, collecting what the row states. Bounded so a
            // row that is partly scrolled off cannot borrow the row above it.
            var amount = ""
            var payer = ""
            var paidAt = ""
            var j = i - 1
            while (j >= 0 && i - j <= 5) {
                val t = ordered[j].first.trim()
                if (phonepeTimeRx.matches(t)) { paidAt = t; break }          // top of the row
                if (amount.isEmpty() && phonepeAmountRx.matches(t)) { j--; amount = t; continue }
                // The payer is the only free text on the row; "•" is the separator between the
                // time and the name and must never be mistaken for one.
                if (payer.isEmpty() && t.isNotBlank() && t != "•" && !phonepeAmountRx.matches(t)) payer = t
                j--
            }

            // PhonePe writes the payer name with a trailing comma on some rows
            // ("Preetam Kesharwani,"); it is punctuation from the layout, not part of the name.
            payer = payer.trim().trimEnd(',', '·', '|').trim()

            // WHAT THE ROW STATED, KEPT VERBATIM.
            //
            // Without this the dashboard's "Details" button does not render at all — it is gated
            // on the alert carrying a details payload (banker-portal/transactions), so a PhonePe
            // credit showed a bare "—" where every Paytm credit offers its breakdown. The list
            // row is all this engine ever sees, so the row is what gets recorded: no invention,
            // and no pretending to know things only a detail screen could tell us.
            val stated = linkedMapOf<String, String>()
            if (paidAt.isNotBlank()) stated["paid_at"] = paidAt
            if (payer.isNotBlank()) stated["payer"] = payer
            if (amount.isNotBlank()) stated["amount"] = amount
            stated["utr"] = rrn
            phonepeModeRx.find(ordered[i].first)?.groupValues?.get(1)?.trim()
                ?.takeIf { it.isNotBlank() }?.let { stated["mode"] = it }   // "QR", "Intent", …
            stated["captured_from"] = "PhonePe for Business · History list"

            // maskedRef = the RRN itself: there is no masked form to expand, and RrnStore uses it
            // as the "seen this payment" key, so the two ledgers stay consistent with Airtel.
            val fresh = RrnStore.record(RrnRecord(
                rrn = rrn, capturedAt = System.currentTimeMillis(),
                amount = amount, payer = payer, upiId = "",
                paidAt = paidAt, maskedRef = rrn, bank = "PHONEPE",
                details = stated,
                eventTime = phonepeEventTime(paidAt),
            ))
            if (fresh) {
                captured++
                Prefs.bump(this, "capture_ok")
                Log.d(TAG, "phonepe: RRN $rrn amount=$amount payer=$payer at=$paidAt")
            }
        }
        if (captured > 0) AlertStore.log(applicationContext, "${nowTag()} 📗 phonepe: captured $captured payment(s) from the list")

        // WALK THE LIST, DO NOT JUST WATCH IT. See PP_SWEEP_INTERVAL_MS.
        if (!Prefs.autoCapture(this)) return
        val onList = ordered.any { phonepeUtrRx.containsMatchIn(it.first) }
        if (!onList) return

        if (ppSweeping) { ppStep(captured); return }
        // Log progress on a long backfill so it is visibly working rather than apparently hung.
        if (ppDeep && ppScrolls > 0 && ppScrolls % 50 == 0) Log.d(TAG, "phonepe: deep pass at $ppScrolls scrolls")

        val now = System.currentTimeMillis()
        if (now - ppLastSweep < PP_SWEEP_INTERVAL_MS) return
        ppLastSweep = now
        ppSweeping = true; ppScrolls = 0; ppDryScreens = 0; ppRewinding = 0
        Log.d(TAG, "phonepe: sweeping the list for payments pushed below the fold")
        ppStep(captured)
    }

    /**
     * One step of the PhonePe list sweep: scroll, let it render, and let the next read happen.
     *
     * Stops as soon as [PP_DRY_SCREENS] screens in a row yield nothing new — normally within a
     * screen or two, because the top of the list is already held — then REWINDS TO THE TOP. That
     * last part matters: new payments appear at the top, and a sweep that finished deep in
     * yesterday's history would leave the engine watching a screen where nothing new ever
     * arrives, quietly stopping live capture in the name of backfilling it.
     */
    private fun ppStep(capturedThisScreen: Int) {
        if (ppRewinding > 0) {
            ppRewinding--
            swipeDown { }
            // BACK AT THE TOP IS NOT THE SAME AS UP TO DATE. See ppPullToRefresh.
            if (ppRewinding == 0) {
                Log.d(TAG, "phonepe: sweep done, back at the top of the list")
                ppPullToRefresh()
            }
            return
        }
        if (capturedThisScreen > 0) ppDryScreens = 0 else ppDryScreens++
        // A BACKFILL DOES NOT STOP AT THE FIRST QUIET SCREEN. The ordinary sweep exists to catch
        // rows a burst pushed below the fold moments ago, so two dry screens means caught up. The
        // day's real gap is scattered far deeper — 392 payments against 202 captured
        // (2026-08-22) — and every screenful of it is already-held rows until it is not. A deep
        // pass therefore walks to the scroll limit regardless.
        val scrollLimit = if (ppDeep) PP_DEEP_SCROLLS else PP_MAX_SCROLLS
        if ((!ppDeep && ppDryScreens >= PP_DRY_SCREENS) || ppScrolls >= scrollLimit) {
            // Rewind by as many swipes as we scrolled down, plus a margin for a short list.
            ppRewinding = minOf(ppScrolls, scrollLimit) + 2
            Log.d(TAG, "phonepe: ${if (ppDeep) "deep pass" else "caught up"} after $ppScrolls scroll(s) -> returning to the top")
            ppDeep = false
            main.postDelayed({ ppStep(0) }, PP_SCROLL_WAIT_MS)
            return
        }
        ppScrolls++
        swipeUp { main.postDelayed({ ppNudge() }, PP_SCROLL_WAIT_MS) }
    }

    /**
     * Re-read the scrolled list ourselves rather than waiting for an event.
     *
     * Accessibility events describe CHANGE, and a list that has finished settling stops emitting
     * them — the same trap that stalled the Paytm sweep. Reading directly keeps the sweep moving.
     */
    private fun ppNudge() {
        if (!ppSweeping) return
        val root = rootInActiveWindow ?: run { ppSweeping = false; return }
        if (root.packageName?.toString() != "com.phonepe.app.business") { ppSweeping = false; return }
        handlePhonePe(root)
    }

    /**
     * PULL THE LIST DOWN. Without this the engine walks a snapshot.
     *
     * PhonePe fetches the History list once, when the screen is opened, and then leaves it
     * alone: scrolling only pages BACKWARDS through rows it already holds, so a payment that
     * arrives while the screen is up never appears at all. The merchant testing the app on
     * 2026-08-24 found the same thing from the other side — nothing reached the dashboard
     * unless he pulled the list down by hand first.
     *
     * The rewind swipe does not do it. That one is a 250ms fling starting mid-screen, which
     * scrolls the list back to the top but never arms the refresh; a pull-to-refresh needs the
     * list already at rest and then a slow, sustained drag. Hence a separate, deliberately slow
     * gesture (700ms over half the screen) issued only once the rewind has finished.
     *
     * Kept clear of both ends of the screen: it starts below the Date Range / Filters chips so
     * it cannot drag one of those, and stops short of the bottom navigation bar.
     */
    private fun ppPullToRefresh() {
        val dm = resources.displayMetrics
        val x = dm.widthPixels / 2f
        val path = Path().apply {
            moveTo(x, dm.heightPixels * 0.32f)
            lineTo(x, dm.heightPixels * 0.78f)
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 700))
            .build()
        val after = Runnable {
            ppSweeping = false
            val root = rootInActiveWindow ?: return@Runnable
            if (root.packageName?.toString() != "com.phonepe.app.business") return@Runnable
            Log.d(TAG, "phonepe: refreshed, re-reading the top of the list")
            handlePhonePe(root)
        }
        val cb = object : GestureResultCallback() {
            override fun onCompleted(d: GestureDescription?) { main.postDelayed(after, PP_REFRESH_WAIT_MS) }
            override fun onCancelled(d: GestureDescription?) { main.postDelayed(after, PP_REFRESH_WAIT_MS) }
        }
        if (!dispatchGesture(gesture, cb, null)) main.postDelayed(after, PP_REFRESH_WAIT_MS)
    }

    private fun handleAirtel(root: AccessibilityNodeInfo) {
        if (!Prefs.enabled(this)) return
        val ordered = ArrayList<Pair<String, AccessibilityNodeInfo>>()
        flatten(root, ordered)

        // One-shot diagnostic: on a screen that has RRNs, upload the real node layout so it
        // can be verified server-side (the Airtel app blocks ADB, so this is our only view).
        // Throttled to once per 60s.
        val now = System.currentTimeMillis()
        if (ordered.any { airtelRrn.containsMatchIn(it.first) } && now - lastAirtelDump > 60_000L) {
            lastAirtelDump = now
            val dump = ordered.joinToString("\n") { (t, n) ->
                val r = Rect().also { n.getBoundsInScreen(it) }
                "\"$t\"  ${n.className}  [${r.left},${r.top}][${r.right},${r.bottom}]"
            }
            AlertUploader.sendAgentDebug(this, "airtel-reports", dump)
        }

        for (i in ordered.indices) {
            for (match in airtelRrn.findAll(ordered[i].first)) {
                val rrn = match.value   // always a 12-digit UPI RRN now

                // Pair by flatten (traversal) order — reliable even when off-screen RecyclerView
                // rows report clamped/degenerate bounds. Each card lists as:
                //   date, time, [payer name], amount, RRN, "charges & GST"
                // so scan backward from the RRN up to this card's time marker, collecting the
                // amount and (for payment rows) the payer name.
                var amount = ""
                var payer = ""
                var j = i - 1
                while (j >= 0 && i - j <= 6) {
                    val t = ordered[j].first.trim()
                    if (timeRx.containsMatchIn(t)) break            // top of this card
                    val tl = t.lowercase()
                    if (amount.isEmpty() && !tl.contains("charge") && !tl.contains("gst") && !tl.contains("collected"))
                        airtelAmount.find(t)?.let { amount = it.value }
                    if (payer.isEmpty() && airtelName.matches(t) && tl !in airtelStop) payer = t
                    j--
                }

                val fresh = RrnStore.record(RrnRecord(
                    rrn = rrn, capturedAt = System.currentTimeMillis(),
                    amount = amount, payer = payer, upiId = "",
                    paidAt = "", maskedRef = rrn, bank = "AIRTEL",
                ))
                if (fresh) { Prefs.bump(this, "capture_ok"); Log.d(TAG, "airtel: RRN $rrn amount=$amount payer=$payer") }
            }
        }

        // Hands-free auto-drive (auto-capture on): keep the app on the reports list and
        // fresh, wherever the merchant left it.
        //  • On the reports list ("search" present): re-run search every ~25s so new
        //    payments (a static search result otherwise) show up on their own.
        //  • On the home screen ("view all transactions", no "search"): open the
        //    transactions list so capture can run — the home screen has no RRNs.
        if (Prefs.autoCapture(this)) {
            val nowR = System.currentTimeMillis()
            val searchNode = ordered.firstOrNull { it.first.trim().equals("search", true) }?.second
            val viewAllNode = ordered.firstOrNull { it.first.trim().equals("view all transactions", true) }?.second
            when {
                searchNode != null && nowR - lastAirtelRefresh > 10_000L -> {
                    lastAirtelRefresh = nowR
                    clickNode(searchNode)
                    Log.d(TAG, "airtel: auto-refresh (search)")
                }
                searchNode == null && viewAllNode != null && nowR - lastAirtelRefresh > 8_000L -> {
                    lastAirtelRefresh = nowR
                    clickNode(viewAllNode)
                    Log.d(TAG, "airtel: auto-nav home -> transactions")
                }
            }
        }
    }

    // ------------------------------------------------------------- Google Pay
    //
    // Google Pay for Business (com.google.android.apps.nbu.paisa.merchant) is a FLUTTER
    // app: it exposes on-screen text as accessibility CONTENT-DESCRIPTIONS, not text nodes
    // (the Paytm/Airtel engines read text, so we read descriptions here). The transaction
    // DETAIL screen shows the real 12-digit UPI RRN in plain text — the whole block arrives
    // as one description like:
    //   "Transaction details … UPI Transaction ID\n310182347603\nGoogle Transaction ID\n
    //    CICAg…\n … Customer paid\n₹15\nAmount you get\n₹15"
    // We take the number after "UPI Transaction ID" (the "Google Transaction ID" is
    // Google's internal ref — ignored).
    //
    // Two modes, same as Paytm:
    //   MANUAL (auto-capture off) — passive. The merchant opens a payment, we read it.
    //   AUTO   (auto-capture on)  — we drive: on the transactions LIST we open each row,
    //                               read the RRN off the detail, press Back, repeat.
    //
    // The auto-drive exists because GPay's list rows do NOT carry the RRN — only the detail
    // screen does — so unlike Airtel there is nothing to read without opening each payment.
    // The sweep stops as soon as a row yields an RRN we already hold: rows are newest-first,
    // so the first duplicate means everything below it is already captured.
    // Currency is matched permissively (₹ / Rs / Rs. / INR). Which glyph actually reaches us
    // depends on the handset's locale and font coverage, not on GPay, so pinning it to "₹"
    // would silently stop capture on a ROM that renders the amount any other way.
    private val gpayAmount = Regex("(?:₹|Rs\\.?|INR)\\s?[0-9][0-9,]*(?:\\.[0-9]{1,2})?", RegexOption.IGNORE_CASE)
    private val rrn12 = Regex("\\d{12}")

    private fun handleGpay(root: AccessibilityNodeInfo) {
        if (!Prefs.enabled(this)) return
        val nodes = ArrayList<Pair<String, AccessibilityNodeInfo>>()
        flattenAll(root, nodes)
        // Join everything so we can index label→value across nodes whether GPay bundles the
        // block into one description or splits it.
        val lines = nodes.joinToString("\n") { it.first }
            .split('\n', '\r').map { it.trim() }.filter { it.isNotEmpty() }

        // Every GPay screen is a chance to learn which business is active: its QR / profile screen
        // states "UPI ID: …", and that is the account this business collects on. Read on every
        // pass, not just on a payment screen, because the merchant may open the QR at any time —
        // and once read, captures can finally say which of the four IDs was credited.
        noteVisibleVpa(lines)

        val rrn = gpayRrn(lines)
        if (rrn != null) {
            // Mark arrival immediately so the sweep's watchdog never gives up on a detail we
            // did reach, even if collecting it below takes a moment.
            if (gpayAutoNavigating) gpayDetailReached = true
            collectGpayDetail(lines, rrn)
            return
        }

        // Not a detail screen — candidate list screen. Only drive when the merchant opted in.
        if (!autoModeEnabled()) return
        gpayMaybeDump(nodes)
        // Only sweep the real transactions list. GPay's HOME screen also shows a couple of
        // recent payments in the same "<name> <time> + ₹<amount>" shape, but those are a
        // summary widget: tapping one opens nothing, so a sweep there burns its whole
        // retry budget on rows that can never open (live symptom 2026-08-15 — a correctly
        // aimed tap at the ₹6 row's exact centre, twice, with no detail). Navigate to the
        // list instead.
        if (!gpayOnTransactionsList(nodes)) { gpayMaybeOpenList(nodes); return }
        if (gpayTryRefresh(nodes)) return       // refresh first; sweep on the next pass
        gpayHandleList(nodes)
    }

    /**
     * Are we on the real transactions list (as opposed to Home)?
     *
     * The list carries its own controls — "Refresh transactions", "Download statement" and
     * a "Transactions | Tab 1 of 2" tab — none of which exist on Home, whose tabs are
     * "Home" and "Profile". Verified against device dumps of both screens.
     */
    private fun gpayOnTransactionsList(nodes: List<Pair<String, AccessibilityNodeInfo>>): Boolean =
        nodes.any { (t, _) ->
            t.contains("Refresh transactions", true) ||
                t.contains("Download statement", true) ||
                t.startsWith("Transactions", true)
        }

    /**
     * Refresh the list before sweeping a notification-triggered capture.
     *
     * GPay's transaction list is a CACHED view: the push for a payment arrives before the
     * list itself contains that payment. Sweeping straight away therefore opens the previous
     * payment's row — so every RRN landed exactly one payment late. Observed live
     * 2026-08-14: the ₹4 at 16:32:47 sat with no RRN until the ₹1 at 16:34:21 triggered the
     * next sweep, which then captured the ₹4.
     *
     * Tapping "Refresh transactions" makes the row we actually came for exist. We return true
     * so this pass does nothing else; the refresh re-renders the list, which fires another
     * accessibility event, and the sweep runs then with forceResweep still armed.
     */
    private fun gpayTryRefresh(nodes: List<Pair<String, AccessibilityNodeInfo>>): Boolean {
        if (gpaySweeping) return false
        val now = System.currentTimeMillis()
        // Two reasons to refresh:
        //   armed   — a credit push told us a payment exists that the cached list lacks
        //   periodic— nothing told us anything. A DEDICATED capture phone may never receive
        //             the push at all: GPay delivers it to whichever device Google considers
        //             active, so a second phone signed into the same merchant account sees
        //             every transaction in-app but is never notified (observed 2026-08-15 —
        //             S23 got every push while the OnePlus agent saw nothing). Left alone
        //             that phone would sweep a cached list forever and capture nothing new.
        val armed = gpayRefreshPending
        if (!armed && now - lastGpayRefresh < GPAY_IDLE_REFRESH_MS) return false
        if (armed && now - lastGpayRefresh < 5_000L) return false
        val btn = nodes.firstOrNull { (t, _) -> t.contains("Refresh transactions", true) }
        if (btn == null) {
            // Nothing to tap on this build/locale — sweep the list as-is rather than stall.
            gpayRefreshPending = false
            return false
        }
        gpayRefreshPending = false
        lastGpayRefresh = now
        // The refreshed list animates in, so rows keep MOVING for a moment afterwards. Tapping
        // during that lands between rows: row #0 was aimed at y=1063 and then y=1205 six
        // seconds later, and neither opened (live 2026-08-15). Hold off sweeping until the
        // layout has settled.
        gpaySettleUntil = now + GPAY_SETTLE_MS
        openGpayRow(btn.second)   // acts on the node itself, never an ancestor
        Log.d(TAG, "gpay: refreshing list (${if (armed) "push-armed" else "periodic"})")
        // Drive the sweep ourselves once the list has settled. A refreshed list that has
        // finished animating is STATIC, so it emits no further accessibility events — waiting
        // for one meant the sweep never ran at all, and the next periodic refresh just
        // restarted the wait. That loop refreshed forever and captured nothing.
        main.postDelayed({
            val root = rootInActiveWindow ?: return@postDelayed
            val settled = ArrayList<Pair<String, AccessibilityNodeInfo>>()
            flattenAll(root, settled)
            if (gpayOnTransactionsList(settled)) gpayHandleList(settled)
        }, GPAY_SETTLE_MS + 400)
        return true
    }

    /**
     * We're inside GPay but not on the transactions list (the launcher drops you on Home).
     * Tap through to the list so the sweep has rows to work with — the same hands-free
     * navigation the Airtel engine does from its home screen.
     */
    private fun gpayMaybeOpenList(nodes: List<Pair<String, AccessibilityNodeInfo>>) {
        if (gpaySweeping) return
        val now = System.currentTimeMillis()
        if (now - lastGpayNav < 8_000L) return
        // "Show all payments" is the real route off Home — verified on-device. The others are
        // kept as fallbacks for other builds/layouts. Clickability is NOT required here for
        // the same reason it is not required for rows: Flutter reports it inconsistently.
        val target = nodes.firstOrNull { (t, _) ->
            t.contains("Show all payments", true) ||       // Home -> transactions list
                t.contains("Show all", true) ||
                t.startsWith("Transactions", true) ||      // the "Transactions | Tab 1 of 2" tab
                t.equals("Show details", true) ||
                t.contains("view all", true)
        } ?: return
        lastGpayNav = now
        openGpayRow(target.second)
        Log.d(TAG, "gpay: navigating to the transactions list via \"${target.first.replace('\n', ' ').take(30)}\"")
    }

    /**
     * The 12-digit UPI transaction id (RRN) on a GPay detail screen, or null if this screen
     * isn't one.
     *
     * Label-first, then a translation-proof fallback. GPay follows the SYSTEM language, so a
     * Hindi/Tamil/Marathi handset renders a translated label — a hard-coded English string
     * would capture nothing at all on those phones. The fallback leans on the one fact that
     * survives translation: the UPI id is the only BARE 12-digit number on the screen.
     * Google's own reference is alphanumeric ("CICAg…") so it cannot collide, and amounts,
     * dates and phone numbers are never exactly 12 digits. Requiring it to be alone on its
     * line keeps a 12-digit substring of some longer id from being mistaken for it.
     */
    private fun gpayRrn(lines: List<String>): String? {
        val labelIdx = lines.indexOfFirst { l ->
            // "Google Transaction ID" sits right next to it and must never win.
            !l.contains("google", true) && l.contains("upi", true) &&
                (l.contains("transaction id", true) || l.contains("txn id", true) || l.contains("ref", true))
        }
        if (labelIdx >= 0 && labelIdx + 1 < lines.size) {
            val v = lines[labelIdx + 1].filter { it.isDigit() }
            if (rrn12.matches(v)) return v
        }
        val bare = lines
            .filter { l -> l.isNotEmpty() && l.all { it.isDigit() || it.isWhitespace() } }
            .map { l -> l.filter { it.isDigit() } }
            .filter { rrn12.matches(it) }
            .distinct()
        return bare.singleOrNull()   // ambiguous screen -> capture nothing rather than guess
    }

    // ── WHICH UPI ID WAS CREDITED ────────────────────────────────────────────────────────
    //
    // A merchant can hold several. This one runs FOUR Google Pay for Business accounts in one
    // app — +91 93554 49766, 81282 85317, 95596 78405, 90919 04144, each with its own UPI ID and
    // its own QR — and a payment lands on exactly one of them. Neither the credit notification
    // nor the phone identifies which: the notification says "₹60,000 received from ANKIT K D",
    // and the phone serves all four. The dashboard could therefore only ever show one ID for
    // every payment, which is what the merchant reported (2026-08-17).
    //
    // The app itself does show the ID — on the QR / profile screen of whichever business is
    // active ("UPI ID: 9091904144@okbizaxis"). So we read it wherever it appears and remember it
    // as the active business's collecting ID; a captured payment then carries the ID that was on
    // screen in the business context it was read from.
    //
    // Two guards, because a WRONG destination is worse than a missing one:
    //   • an ID found on the payment's OWN detail screen always beats the remembered one;
    //   • the remembered one expires (ACTIVE_VPA_TTL_MS). A stale read from a business the
    //     merchant has since switched away from must never be stamped onto a new payment.
    private val vpaRe = Regex("\\b([A-Za-z0-9][A-Za-z0-9._-]{1,60}@[A-Za-z][A-Za-z0-9.-]{1,20})\\b")
    // Handles of PAYERS, not of the merchant: a payer VPA on a receipt must never be mistaken
    // for the account credited. Consumer handles dominate the payer side; business ones
    // (@okbizaxis, @paytm-merchant style) dominate the payee side.
    private val payerHandles = setOf(
        "oksbi", "okhdfcbank", "okicici", "okaxis", "ybl", "ibl", "axl", "apl", "paytm", "upi",
    )
    private var activeVpa: String? = null
    private var activeVpaAt = 0L
    private val ACTIVE_VPA_TTL_MS = 10 * 60 * 1000L

    /**
     * An EMAIL IS NOT A UPI ID. Live on-device (2026-08-17) this read
     * "sulemani80551234@gmail.com" and "arthurkumar009@gmail.com" off a GPay account screen and
     * called them the collecting UPI ID — which would have stamped a Gmail address onto captured
     * credits as their destination and then flagged every one as a VPA mismatch.
     *
     * The distinction is structural, not a denylist: a UPI handle has NO dot (@okbizaxis, @oksbi,
     * @ybl, @pty, @axl …) while an email domain always does. So a dotted handle is rejected
     * outright, and that alone rules out every address on the screen.
     */
    private fun isUpiHandle(vpa: String): Boolean {
        val handle = vpa.substringAfter('@', "")
        return handle.isNotEmpty() && !handle.contains('.')
    }

    /** Remember any merchant UPI ID visible on screen as the active business's collecting ID. */
    private fun noteVisibleVpa(lines: List<String>) {
        for (line in lines) {
            // "UPI ID: x@y" is the labelled form the QR / profile screen uses. A bare VPA is
            // accepted only from a short line — a field rather than a sentence that happens to
            // contain a handle.
            val labelled = line.contains("upi id", ignoreCase = true)
            if (!labelled && line.length > 60) continue
            val m = vpaRe.find(line) ?: continue
            val vpa = m.groupValues[1].lowercase()
            val handle = vpa.substringAfter('@')
            if (!isUpiHandle(vpa)) continue                        // an email address, not a VPA
            if (!labelled && handle in payerHandles) continue      // looks like a payer's handle
            if (vpa != activeVpa) {
                Log.d(TAG, "gpay: active business UPI ID = $vpa")
                AlertStore.log(applicationContext, "${nowTag()} 🏷️ collecting on $vpa")
            }
            activeVpa = vpa
            activeVpaAt = System.currentTimeMillis()
            return
        }
    }

    /** The UPI ID to stamp on a capture: the payment's own screen first, else the active one. */
    private fun payeeVpaFor(fields: Map<String, String>): String? {
        fields["payee_vpa"]?.takeIf { it.isNotBlank() }?.let { return it.lowercase() }
        val v = activeVpa ?: return null
        return if (System.currentTimeMillis() - activeVpaAt <= ACTIVE_VPA_TTL_MS) v else null
    }

    // Labels on the GPay detail screen, each followed by its value on the next line.
    // Verified against a live device dump 2026-08-15 (OnePlus 8, Android 13).
    private val gpayLabels = mapOf(
        "Payment method" to "payment_method",
        "UPI Transaction ID" to "upi_transaction_id",
        "Google Transaction ID" to "google_transaction_id",
        "Paid via" to "paid_via",
        "Customer paid" to "customer_paid",
        "Amount you get" to "amount_you_get",
    )
    // The bottom-most field: once we have it, the whole screen has been seen.
    private val GPAY_LAST_FIELD = "amount_you_get"

    /**
     * Collect a GPay transaction detail, scrolling until the whole record is visible.
     *
     * WHY THE SCROLLING. Flutter only publishes RENDERED widgets to the accessibility tree,
     * so a detail screen exposes just what is on screen. The RRN sits near the fold and is
     * therefore readable straight away — which is why RRN capture worked while everything
     * below it stayed invisible. "Google Transaction ID", "Paid via", "Customer paid" and
     * "Amount you get" only appear after a scroll (verified on-device 2026-08-15).
     *
     * So the record is assembled across several reads: merge what this pass can see, scroll
     * if the last field is still missing, and only upload once the screen is complete or the
     * scroll budget runs out. Uploading on the first read instead would permanently lose the
     * lower half, because [RrnStore] dedupes by RRN and would reject the enriched second copy.
     */
    private fun collectGpayDetail(lines: List<String>, rrn: String) {
        if (rrn != gpayDetailRrn) {          // a different payment than we were collecting
            gpayDetailRrn = rrn
            gpayDetailFields.clear()
            gpayDetailScrolls = 0
            // Safety net: if scrolling produces no further accessibility events we would sit
            // here forever, so commit what we have regardless after a short grace period.
            val gen = ++gpayDetailGen
            main.postDelayed({
                if (gen == gpayDetailGen && gpayDetailRrn == rrn) finishGpayDetail(rrn)
            }, 3500)
        }
        mergeGpayFields(lines)

        val complete = gpayDetailFields.containsKey(GPAY_LAST_FIELD)
        if (!complete && gpayDetailScrolls < 2) {
            gpayDetailScrolls++
            swipeUp { }   // the re-render fires another event, which re-enters here
            return
        }
        finishGpayDetail(rrn)
    }

    /** Merge every field visible on this pass into the record being assembled. */
    private fun mergeGpayFields(lines: List<String>) {
        for (i in lines.indices) {
            val line = lines[i]
            gpayLabels[line]?.let { key ->
                if (i + 1 < lines.size && !gpayDetailFields.containsKey(key)) {
                    gpayDetailFields[key] = lines[i + 1]
                }
            }
            when {
                line.startsWith("Received from", true) ->
                    gpayDetailFields.putIfAbsent("received_from",
                        line.replaceFirst(Regex("(?i)^received from"), "").trim())
                line.contains("credited", true) && gpayAmount.containsMatchIn(line) ->
                    gpayDetailFields.putIfAbsent("credited", line)
                line.contains("Settlement", true) ->
                    gpayDetailFields.putIfAbsent("settlement", line)
                gpayRowTime.containsMatchIn(line) && line.length <= 40 ->
                    gpayDetailFields.putIfAbsent("paid_at", line)
            }
        }
        // The destination account, if this screen names it — the strongest form, since it belongs
        // to the payment being read rather than to whatever business was last on screen.
        for (line in lines) {
            if (!line.contains("upi id", ignoreCase = true)) continue
            // "UPI Transaction ID" is the RRN label, not an account.
            if (line.contains("transaction", ignoreCase = true)) continue
            val v = vpaRe.find(line)?.groupValues?.get(1)?.lowercase() ?: continue
            if (!isUpiHandle(v)) continue                          // an email address, not a VPA
            gpayDetailFields.putIfAbsent("payee_vpa", v)
        }
        noteVisibleVpa(lines)

        // Diagnostic, per pass (the screen arrives in halves as it scrolls): tell us what this
        // screen says that we are not indexing — specifically, whether it names the UPI ID that
        // received the payment.
        reportUnknownGpayFields(lines)
    }

    // WHICH UPI ID RECEIVED THE MONEY? A banker can collect on several (PRVZS23 has four), and
    // nothing we capture today says which one a given payment landed on — the dashboard could
    // only ever show the banker's primary VPA, so payments to different IDs all read the same
    // (client question 2026-08-17). The GPay detail screen might name it: we index just six
    // labels off that screen and discard every other labelled line, so if a "received in" /
    // "paid to" line is sitting there we would never know.
    //
    // This reports the lines we throw away — ONCE per distinct screen layout, redacted the same
    // way the unparsed-notification reporter is (digit runs masked, so amounts and references
    // cannot travel). If the receiving UPI ID turns out to be on screen, capturing it is then
    // one entry in `gpayLabels`. Purely diagnostic: it changes no capture behaviour.
    private fun reportUnknownGpayFields(lines: List<String>) {
        val known = gpayLabels.keys
        val unknown = lines.filter { l ->
            l.isNotBlank() && l.length in 3..80 && l !in known &&
                !l.startsWith("Received from", true) &&
                !l.contains("credited", true) &&
                !gpayRowTime.containsMatchIn(l) &&
                // A value line (a bare number / amount) tells us nothing about labels.
                !l.all { it.isDigit() || it.isWhitespace() || it == '₹' || it == ',' || it == '.' }
        }.distinct()
        if (unknown.isEmpty()) return
        // A VPA in ANY line is the answer to the question, so say so loudly in the report.
        val vpaSeen = unknown.any { Regex("[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}").containsMatchIn(it) }
        val body = (if (vpaSeen) "VPA-LIKE TEXT PRESENT\n" else "") +
            unknown.joinToString("\n") { maskDigits(it) }
        val key = "gpay-fields|${unknown.sorted().joinToString("|").hashCode()}"
        if (AlertStore.seenRecently(applicationContext, key)) return
        AlertUploader.sendAgentDebug(applicationContext, "gpay-detail-unknown-fields", body)
        AlertStore.log(applicationContext, "${nowTag()} 🔎 reported ${unknown.size} unindexed GPay fields")
    }

    // Keep the SHAPE of a line and drop the values: long digit runs become X of the same
    // length, so a label is still readable while amounts, references and phone numbers are not.
    private fun maskDigits(s: String): String =
        Regex("\\d{4,}").replace(s) { "X".repeat(it.value.length) }

    /** Commit the assembled record exactly once. */
    private fun finishGpayDetail(rrn: String) {
        if (gpayDetailRrn != rrn) return
        gpayDetailRrn = null
        gpayDetailGen++          // cancel the pending safety-net finalize
        onCaptureFinished(applicationContext)   // this payment is done; let the next start
        val details = HashMap(gpayDetailFields)
        gpayDetailFields.clear()
        val fresh = captureGpayDetail(details, rrn)
        if (gpayAutoNavigating) {
            gpayLastResult = if (fresh) R_NEW else R_OLD
            if (!gpayBackScheduled) {
                gpayBackScheduled = true
                main.postDelayed({ gpayGoBackToList() }, 600)
            }
        } else if (!bridgeBackScheduled &&
                   System.currentTimeMillis() - bridgeOpenedAt < BRIDGE_OWNED_MS) {
            // Opened by a notification rather than the sweep — leave it as Paytm now does, so the
            // phone is not parked on one payment's screen.
            bridgeBackScheduled = true
            val bgen = bridgeGen
            main.postDelayed({ returnFromDetail(0, bgen) }, 800)
        }
    }

    /**
     * Store and upload an assembled GPay detail. Returns true if this RRN is newly captured,
     * false if we already had it — which is the sweep's stop signal.
     */
    private fun captureGpayDetail(fields: Map<String, String>, rrn: String): Boolean {
        // The amount the CUSTOMER PAID is the one that matches the merchant's order, so it
        // leads. "Amount you get" is what lands after GPay's cut — identical today on this
        // account, but storing both means the day they diverge is visible rather than silent.
        // The "₹1 credited" summary and then any amount at all are the last resorts, which is
        // what keeps a translated UI working: the amount stays a number whatever the labels
        // around it say.
        val amount = listOfNotNull(
            fields["customer_paid"], fields["amount_you_get"], fields["credited"],
        ).firstNotNullOfOrNull { gpayAmount.find(it)?.value } ?: ""

        val payer = fields["received_from"] ?: ""

        val payee = payeeVpaFor(fields)
        val fresh = RrnStore.record(RrnRecord(
            rrn = rrn, capturedAt = System.currentTimeMillis(),
            amount = amount, payer = payer, upiId = "",
            paidAt = fields["paid_at"] ?: "", maskedRef = rrn, bank = "GPAY",
            details = fields.takeIf { it.isNotEmpty() },
            payeeVpa = payee,
        ))
        if (fresh) {
            Prefs.bump(this, "capture_ok")
            Log.d(TAG, "gpay: RRN $rrn amount=$amount payer=$payer payee=${payee ?: "-"} fields=${fields.keys.sorted()}")
        } else Log.d(TAG, "gpay: RRN $rrn already captured")
        return fresh
    }

    // ------------------------------------------------------ GPay auto-drive

    private fun gpayHandleList(nodes: List<Pair<String, AccessibilityNodeInfo>>) {
        val now = System.currentTimeMillis()
        // Stuck-sweep guard. A sweep interrupted mid-flight (merchant switches app, screen
        // off, GPay restarts) leaves gpaySweeping=true with no pending timer to ever clear
        // it — every later sweep would be blocked for the life of the process and capture
        // would quietly stop until the app was restarted. Time it out instead.
        if (gpaySweeping && now - gpaySweepStarted > 90_000L) {
            Log.w(TAG, "gpay: sweep stalled; resetting")
            gpaySweeping = false
        }
        if (gpaySweeping) return
        // A just-refreshed list is still animating; tapping into it hits moving rows.
        // Applies even to forceResweep — arriving 2s later beats missing the row entirely.
        if (now < gpaySettleUntil) return
        // forceResweep ("Get RRN" pressed on the dashboard) jumps the interval — the whole
        // point of that button is not to wait.
        if (!forceResweep && now - lastGpaySweep < GPAY_SWEEP_INTERVAL_MS) return
        val rows = findGpayRowNodes(nodes)
        if (rows.isEmpty()) return
        if (forceResweep) { forceResweep = false; Log.d(TAG, "gpay: on-demand resweep") }

        lastGpaySweep = now
        gpaySweeping = true
        gpaySweepStarted = now
        gpaySweepPos = 0
        gpayOpenRetries = 0
        gpayRowRetried = false
        Log.d(TAG, "gpay: sweeping ${rows.size} visible row(s)")
        gpayOpenNext()
    }

    /**
     * The payment rows on the GPay transactions list, top (newest) to bottom.
     *
     * Tuned against a real device dump (`vendor_agent_debug` label `gpay-list`), which is
     * what this list actually looks like:
     *
     *   "Lincoln K\n14 Aug, 9:12 pm\n+ ₹1"   android.widget.Button  click=true
     *   "Kush D\n14 Aug, 8:44 pm\n+ ₹1"      android.widget.Button  click=true
     *   "Received since last settlement"     android.view.View      click=false
     *   "₹2"                                 android.view.View      click=false
     *   "14 Aug 2026\n₹3"                    android.view.View      click=false
     *   "Settle now" / "Show details"        android.widget.Button  click=true
     *
     * A payment row carries NO "received/credited/paid" wording — the credit marker is the
     * leading "+ ₹". A row is identified by carrying BOTH that marker and a time-of-day,
     * which is exactly what separates it from everything else on the screen:
     *
     *   payment row    "+ ₹4"   and  "10:02 pm"    -> both        TAP
     *   day header     "₹14"         "14 Aug 2026" -> no clock    skip
     *   settlement sum "₹10"         -             -> amount only skip
     *   Settle now / Show details / tabs           -> no amount   skip
     *
     * DO NOT reintroduce an isClickable requirement here. It looks like the obvious
     * selector and it is a trap: these very rows reported click=true at 16:17 and
     * click=FALSE at 16:33 on one device within one session (both dumps are in
     * vendor_agent_debug). Flutter publishes its semantics inconsistently depending on where
     * in the render cycle the tree is read, so gating on that flag silently matches nothing
     * and capture stops dead with no error. [clickNode] walks up for a clickable ancestor
     * and otherwise taps the node's own bounds, so opening a row never needs the flag set.
     */
    // "+ ₹1" — the credit marker. The currency symbol stays REQUIRED here (unlike the
    // fallback below) because a bare "+<digits>" would also match a phone number.
    private val gpayCredit = Regex("\\+\\s*(?:₹|Rs\\.?|INR)\\s*[0-9]", RegexOption.IGNORE_CASE)
    // Accepts both 12-hour ("9:12 pm") and 24-hour ("21:12") clocks — the handset's clock
    // setting decides which GPay renders, and a 24-hour phone must not fall out of the sweep.
    private val gpayRowTime = Regex("\\d{1,2}:\\d{2}(?:\\s?[ap]\\.?m\\.?)?", RegexOption.IGNORE_CASE)

    private fun findGpayRowNodes(nodes: List<Pair<String, AccessibilityNodeInfo>>): List<AccessibilityNodeInfo> {
        // A recycler reports rows that exist in the list but are scrolled off the screen.
        // Tapping one is worse than useless: at best it hits nothing, and near the bottom
        // edge it lands in the system gesture strip and sends the phone HOME, backgrounding
        // GPay mid-sweep (live 2026-08-15 — taps at y=2141 and y=2378 on a 2400px screen
        // dropped us onto the launcher). Only ever tap rows fully inside the usable area.
        val screenH = resources.displayMetrics.heightPixels
        val safeBottom = screenH - GPAY_EDGE_MARGIN_PX

        fun collect(match: (String) -> Boolean): List<AccessibilityNodeInfo> {
            val hits = ArrayList<Pair<Int, AccessibilityNodeInfo>>()
            val seen = HashSet<Int>()
            for ((raw, n) in nodes) {
                if (!match(raw.replace('\n', ' '))) continue
                val r = Rect().also { n.getBoundsInScreen(it) }
                if (r.width() <= 0 || r.height() <= 0) continue
                if (r.top < 0 || r.bottom > safeBottom) continue   // off-screen / under the nav bar
                if (!seen.add(r.top)) continue   // same row reached via desc AND text
                hits.add(r.top to n)
            }
            return hits.sortedBy { it.first }.take(GPAY_MAX_ROWS).map { it.second }
        }
        // Credit marker AND a clock — the combination no header or total on this screen has.
        val rows = collect { gpayCredit.containsMatchIn(it) && gpayRowTime.containsMatchIn(it) }
        if (rows.isNotEmpty()) return rows
        // Locale fallback: a clock plus any amount. Looser, but a day header still has no
        // time-of-day, so the aggregates stay excluded.
        return collect { gpayAmount.containsMatchIn(it) && gpayRowTime.containsMatchIn(it) }
    }

    private fun gpayOpenNext() {
        if (!gpaySweeping) return
        val root = rootInActiveWindow
        val nodes = ArrayList<Pair<String, AccessibilityNodeInfo>>()
        if (root != null) flattenAll(root, nodes)
        val rows = findGpayRowNodes(nodes)
        if (rows.isEmpty()) {
            // List hasn't settled yet (previous detail still closing) — retry, then give up.
            if (gpayOpenRetries++ < 6) main.postDelayed({ gpayOpenNext() }, 500) else {
                gpaySweeping = false
                Log.d(TAG, "gpay: list never settled; sweep abandoned")
            }
            return
        }
        gpayOpenRetries = 0
        if (gpaySweepPos >= rows.size) {
            gpaySweeping = false
            Log.d(TAG, "gpay: swept all visible rows -> waiting for new payments")
            return
        }

        val row = rows[gpaySweepPos]
        gpayAutoNavigating = true
        gpayBackScheduled = false
        gpayDetailReached = false
        gpayLastResult = R_UNKNOWN
        val gen = ++gpayOpenGen
        Prefs.bump(this, "capture_try")
        openGpayRow(row)
        // Watchdog: if the tap never opened a detail, retry the row once with twice the
        // patience before giving up on it. A slow phone under load routinely misses the first
        // deadline; skipping straight past would drop that payment's RRN for good.
        val wait = if (gpayRowRetried) GPAY_DETAIL_WAIT_MS * 2 else GPAY_DETAIL_WAIT_MS
        main.postDelayed({
            if (gen == gpayOpenGen && gpaySweeping && !gpayDetailReached) {
                gpayAutoNavigating = false
                if (!gpayRowRetried) {
                    gpayRowRetried = true
                    Log.w(TAG, "gpay: row #$gpaySweepPos did not open; retrying once")
                    gpayOpenNext()
                } else {
                    Log.w(TAG, "gpay: row #$gpaySweepPos did not open; skipping")
                    noteCaptureFail("gpay row did not open")
                    gpayRowRetried = false
                    gpaySweepPos++
                    gpayOpenNext()
                }
            }
        }, wait)
    }

    /**
     * Open one payment row.
     *
     * Deliberately NOT [clickNode]: that walks UP to six ancestors looking for something
     * clickable, and on this list the row itself reports click=false while an ancestor (the
     * scroll container) reports true — so it clicked the container, did nothing, and still
     * reported success. Live symptom 2026-08-15: "row #0 did not open" twice in a row while
     * the sweep, refresh and trigger were all working perfectly.
     *
     * The row IS the visual target, so we act on the row or not at all: ACTION_CLICK when it
     * advertises itself as clickable, otherwise a real tap at its own centre.
     */
    private fun openGpayRow(node: AccessibilityNodeInfo): Boolean {
        if (node.isClickable) {
            Log.d(TAG, "gpay: opening row #$gpaySweepPos (ACTION_CLICK)")
            return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        }
        val r = Rect().also { node.getBoundsInScreen(it) }
        if (r.width() <= 0 || r.height() <= 0) {
            Log.w(TAG, "gpay: row #$gpaySweepPos has no bounds to tap")
            return false
        }
        Log.d(TAG, "gpay: opening row #$gpaySweepPos (tap ${r.exactCenterX().toInt()},${r.exactCenterY().toInt()})")
        tap(r.exactCenterX(), r.exactCenterY())
        return true
    }

    private fun gpayGoBackToList() {
        gpayAutoNavigating = false
        gpayBackScheduled = false
        gpayBackAttempts = 0
        gpayWaitChecks = 0
        gpayPressBackThenVerify()
    }

    private fun gpayPressBackThenVerify() {
        performGlobalAction(GLOBAL_ACTION_BACK)
        main.postDelayed({ gpayVerifyOnList() }, 700)
    }

    private fun gpayVerifyOnList() {
        if (!gpaySweeping) return
        val root = rootInActiveWindow
        val nodes = ArrayList<Pair<String, AccessibilityNodeInfo>>()
        if (root != null) flattenAll(root, nodes)
        // Same detector as the capture path, so "am I still on a detail?" can never disagree
        // with "did I read a detail?" — and it stays correct on a translated UI.
        val lines = nodes.joinToString("\n") { it.first }
            .split('\n', '\r').map { it.trim() }.filter { it.isNotEmpty() }
        val stillOnDetail = gpayRrn(lines) != null
        val onList = findGpayRowNodes(nodes).isNotEmpty()
        val pkg = root?.packageName?.toString()
        when {
            // Check detail BEFORE list: a detail screen also shows an amount + "paid", so it
            // can satisfy the row test. Reading it as "we're back" would tap on the detail.
            stillOnDetail && gpayBackAttempts < 3 -> { gpayBackAttempts++; gpayPressBackThenVerify() }
            onList -> gpayOnReturned()
            pkg == "com.google.android.apps.nbu.paisa.merchant" && gpayWaitChecks < 6 -> {
                gpayWaitChecks++; main.postDelayed({ gpayVerifyOnList() }, 500)   // mid-transition
            }
            else -> {
                Log.w(TAG, "gpay: could not return to the list; pausing sweep")
                gpaySweeping = false
            }
        }
    }

    private fun gpayOnReturned() {
        if (!gpaySweeping) return
        if (gpayLastResult == R_OLD) {
            gpaySweeping = false
            Log.d(TAG, "gpay: reached an already-captured payment -> sweep complete")
            return
        }
        gpayRowRetried = false
        gpaySweepPos++
        gpayOpenNext()
    }

    /**
     * One-shot diagnostic: upload the real node layout of a GPay screen so its structure can
     * be inspected server-side (`vendor_agent_debug`). GPay is Flutter, so the selectors in
     * [findGpayRows] are text heuristics rather than ids — this is how we tune them against
     * what the app actually renders. Throttled to once every 2 minutes.
     */
    private fun gpayMaybeDump(nodes: List<Pair<String, AccessibilityNodeInfo>>) {
        val now = System.currentTimeMillis()
        if (now - lastGpayDump < 120_000L) return
        if (nodes.none { gpayAmount.containsMatchIn(it.first) }) return
        lastGpayDump = now
        val dump = nodes.joinToString("\n") { (t, n) ->
            val r = Rect().also { n.getBoundsInScreen(it) }
            "\"${t.replace("\n", "\\n")}\"  ${n.className}  click=${n.isClickable}  [${r.left},${r.top}][${r.right},${r.bottom}]"
        }
        AlertUploader.sendAgentDebug(this, "gpay-list", dump)
    }

    // Flutter semantics live in contentDescription; also fold in any real text nodes.
    // (`flatten` above reads only .text, which is empty throughout GPay.)
    private fun flattenAll(node: AccessibilityNodeInfo?, out: MutableList<Pair<String, AccessibilityNodeInfo>>) {
        if (node == null) return
        node.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it to node) }
        node.text?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it to node) }
        for (i in 0 until node.childCount) flattenAll(node.getChild(i), out)
    }

    // ---------------------------------------------------------------- detail

    // A capture attempt that went nowhere, with the reason. Counted for the heartbeat and
    // reported once per distinct reason per day so a Paytm layout change surfaces as a
    // fixable message instead of a queue of expired requests.
    private fun noteCaptureFail(reason: String) {
        Prefs.bump(this, "capture_fail")
        AlertStore.log(applicationContext, "${nowTag()} ⚠️ capture failed: $reason")
        if (!AlertStore.seenRecently(applicationContext, "capfail|$reason")) {
            AlertUploader.sendAgentDebug(applicationContext, "capture-fail", reason)
        }
    }

    private fun nowTag(): String =
        java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())

    private fun handleDetail(
        ordered: List<Pair<String, AccessibilityNodeInfo>>, texts: List<String>, autoMode: Boolean
    ) {
        // If we auto-opened this detail, note we reached it and schedule the return
        // to the list up-front so we never get stuck here even if capture is skipped.
        if (autoMode && autoNavigating) {
            detailReached = true
            if (!backScheduled) {
                backScheduled = true
                main.postDelayed({ goBackToList() }, AUTO_DETAIL_BACK_MS)
            }
        }

        // WHO OPENED THIS SCREEN DECIDES WHETHER WE LEAVE IT.
        //
        // The return above only runs for a detail the SWEEP opened. Since the notification bridge
        // started opening payments directly, `autoNavigating` is false for those — so the RRN was
        // captured and the app was then left sitting on the payment's detail page, which is what
        // the merchant reported (2026-08-17). Their own taps must NOT be undone (yanking the
        // screen away mid-read would be worse), so the trigger is narrow: only a detail this agent
        // opened via a notification intent, and only within a minute of doing so.
        if (autoMode && !autoNavigating && !bridgeBackScheduled &&
            System.currentTimeMillis() - bridgeOpenedAt < BRIDGE_OWNED_MS) {
            bridgeBackScheduled = true
            val gen = bridgeGen
            main.postDelayed({ returnFromDetail(0, gen) }, BRIDGE_BACK_MS)
        }

        val now = System.currentTimeMillis()
        if (now < detailBusyUntil) return

        val rrnLabelIdx = texts.indexOfFirst { it.equals("RRN", true) }
        if (rrnLabelIdx < 0) return

        Prefs.bump(this, "capture_try")

        // WHICH "Copy" BELONGS TO THE RRN? Paytm's detail screen carries three of them —
        // Order ID, Transaction ID and RRN — each on its own row, each labelled exactly "Copy".
        //
        // This used to take the first Copy that appeared AFTER the masked reference in flatten
        // order, i.e. tree order, on the assumption that tree order matches what you see. It does
        // not reliably: on 2026-08-21 every single clipboard failure came back "clipboard held a
        // different reference" — 113 of them against 105 successes. The tap was landing on a real
        // Copy control and faithfully copying the wrong field, most often the Transaction ID,
        // which is also a long digit run and so passed every check except the mask.
        //
        // Rows are a visual fact, so match on geometry instead: the Copy that belongs to the RRN
        // is the one sitting on the RRN's own row. Tree order is not consulted at all.
        var masked: String? = null
        var maskedNode: AccessibilityNodeInfo? = null
        for (i in rrnLabelIdx + 1 until ordered.size) {
            val t = ordered[i].first
            if (maskedRrn.containsMatchIn(t)) {
                masked = maskedRrn.find(t)!!.value
                maskedNode = ordered[i].second
                break
            }
        }
        val copyNode: AccessibilityNodeInfo? = maskedNode?.let { mn ->
            val mRect = Rect().also { mn.getBoundsInScreen(it) }
            if (mRect.height() <= 0) {
                // The RRN row is not laid out yet — below the fold. Nothing can be matched against
                // a row that has no position, so fall through with a null Copy and let the
                // scroll-to-it branch below bring the whole row on screen first.
                null
            } else {
                ordered.asSequence()
                    .filter { it.first.trim().equals("Copy", true) }
                    .mapNotNull { (_, node) ->
                        val r = Rect().also { node.getBoundsInScreen(it) }
                        if (r.height() > 0) node to r else null
                    }
                    // Same row = vertical centres within roughly one row height of each other.
                    // A Copy two rows up is a different field and must never be accepted.
                    .filter { (_, r) -> kotlin.math.abs(r.exactCenterY() - mRect.exactCenterY()) <= mRect.height() * 1.5f }
                    .minByOrNull { (_, r) -> kotlin.math.abs(r.exactCenterY() - mRect.exactCenterY()) }
                    ?.first
            }
        }
        // A missing Copy is no longer a dead end: it means the RRN row is not on screen yet, and
        // the scroll branch below exists precisely to bring it there. Only a missing masked
        // reference is a genuine layout change worth reporting.
        if (masked == null) {
            // The screen has an RRN label but not the shape we expect — usually a Paytm
            // layout change. Previously this returned silently and the capture request just
            // expired, telling nobody anything.
            noteCaptureFail("no masked RRN after the RRN label")
            return
        }
        // Tell the auto-sweep whether this row is new or an already-captured
        // boundary (this is how the sweep knows where "new" ends).
        if (autoNavigating) lastOpenResult = if (RrnStore.isMaskedCaptured(masked)) R_OLD else R_NEW
        // ALREADY HELD, OR GIVEN UP ON — the answer is known the moment the masked reference is
        // read, so release the capture slot now. Sitting here until the deadline expired is what
        // let a re-opened payment cost as much queue time as a real capture.
        val n = attempts.getOrDefault(masked, 0)
        if (RrnStore.isMaskedCaptured(masked) || n >= MAX_ATTEMPTS) {
            // TWO VERY DIFFERENT THINGS USED TO SHARE THIS SILENT RETURN, and the counters could
            // not tell them apart. "Already captured" is the sweep working correctly — it is how
            // it finds where new payments end. "Attempts exhausted" is a payment this phone saw,
            // tried four times, and has now abandoned FOREVER (`attempts` only clears when the
            // service restarts). The second is lost money and was reported nowhere: on 2026-08-21
            // eighteen Paytm payments were taken and one was captured, while the only counter that
            // moved was capture_try — 277 of them in eighteen minutes, all landing here.
            if (!RrnStore.isMaskedCaptured(masked)) {
                Prefs.bump(this, "capture_giveup")
                AlertStore.log(applicationContext, "${nowTag()} ⛔ gave up on a payment after $MAX_ATTEMPTS attempts")
                if (!AlertStore.seenRecently(applicationContext, "giveup|$masked")) {
                    AlertUploader.sendAgentDebug(
                        applicationContext, "capture-giveup",
                        "abandoned after $MAX_ATTEMPTS attempts; the RRN was never read off the screen",
                    )
                }
            }
            // AND STOP RE-READING THIS SCREEN. This return skipped the detailBusyUntil stamp set
            // by a real attempt below, so every accessibility event on the same detail re-entered
            // and re-counted — which is what inflated capture_try into the hundreds while nothing
            // was actually being captured. A decided screen is decided; leave it alone.
            detailBusyUntil = now + BUSY_MS
            if (!autoNavigating) onPaytmCaptureDone(applicationContext)
            return
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            Log.w(TAG, "screenshot capture needs Android 11+; cannot auto-tap on this device")
            noteCaptureFail("Android ${Build.VERSION.SDK_INT} — on-screen capture needs Android 11+")
            attempts[masked] = MAX_ATTEMPTS
            return
        }

        attempts[masked] = n + 1
        detailBusyUntil = now + BUSY_MS

        val sw = resources.displayMetrics.widthPixels
        val cRect = Rect().also { copyNode?.getBoundsInScreen(it) }

        // NEVER GUESS WHERE "Copy" IS. A node with zero bounds is not laid out — the RRN block
        // sits below the fold of Paytm's detail screen and only materialises once scrolled to.
        // This used to fall through to a guessed column (COPY_X_FRAC) and then hunt that strip
        // for blue pixels, taking the LAST cluster found. On this screen the blue things in that
        // strip are the payer's avatar circle and the "Settle Now" button, so the engine tapped
        // those instead. Live proof, 2026-08-21 13:40–13:43 on a OnePlus IN2011: every capture
        // logged `found Copy at (919.5,1843.5)`, and "Settle Now" occupies [717,1796][993,1892] —
        // its exact centre. Eighteen payments produced no RRN and eighteen presses of a button
        // that moves money.
        //
        // So: if the Copy link is not on screen, scroll until it is and let the next scan handle
        // it. An off-screen node is a reason to scroll, never a reason to tap a coordinate that
        // no node claimed.
        if (copyNode == null || cRect.width() <= 0 || cRect.height() <= 0) {
            Log.d(TAG, "RRN Copy is below the fold (no bounds) -> scrolling to it")
            if (scrollsForCopy.getOrDefault(masked, 0) >= MAX_COPY_SCROLLS) {
                noteCaptureFail("RRN Copy never came on screen after $MAX_COPY_SCROLLS scrolls")
                attempts[masked] = MAX_ATTEMPTS
                onPaytmCaptureDone(applicationContext)
                return
            }
            scrollsForCopy[masked] = scrollsForCopy.getOrDefault(masked, 0) + 1
            // This visit did not consume a capture attempt — nothing was tapped.
            attempts[masked] = n
            // HOLD THE SCREEN WHILE THE SCROLL IS IN FLIGHT. A single detail screen fires five or
            // six content events inside 100ms; without this gate every one of them re-entered and
            // spent another scroll from the budget, so all four were gone before the first gesture
            // had even been dispatched — the scroll never got the chance to work.
            detailBusyUntil = now + COPY_SCROLL_WAIT_MS
            // AND LOOK AGAIN OURSELVES. Accessibility events describe CHANGE, so they stop once the
            // scrolled screen settles — waiting for one after the gesture meant the capture was
            // never retried and the sweep simply moved to the next row. Live proof, 2026-08-21:
            // rows 1-3 of a 205-payment backfill each logged "scrolling to it" and were then
            // abandoned without a single tap. The scroll now re-reads the screen it just moved.
            // FIRST ATTEMPT: THE THROW THAT IS KNOWN TO WORK. Only reach further once it is
            // proven insufficient.
            //
            // A longer swipe finds the RRN in one move when the block sits far down, but
            // overshooting is worse than undershooting: scroll past the RRN row and it leaves the
            // viewport upwards, where every further scroll makes it less reachable and the
            // capture fails outright. The common case already succeeds on the first standard
            // swipe, so that case is left exactly as measured; only a screen that has already
            // failed once — where the extra distance can only help — gets the longer throw.
            val reach: ((() -> Unit) -> Unit) =
                if (scrollsForCopy.getOrDefault(masked, 0) <= 1) ::swipeUp else ::swipeUpFar
            reach {
                detailBusyUntil = 0L
                rereadAfterCopyScroll(autoMode, 0)
            }
            return
        }
        scrollsForCopy.remove(masked)

        val copyX = cRect.exactCenterX()
        val margin = (sw * 0.02f).toInt()
        val bandX0 = cRect.left - margin
        val bandX1 = cRect.right + margin
        val amount = texts.firstNotNullOfOrNull { amountRx.find(it)?.value } ?: ""
        val paidAt = texts.firstOrNull { it.startsWith("Paid at", true) } ?: ""
        val payer = valueAfter(texts, "Name:") ?: valueAfter(texts, "From") ?: ""
        val upiId = valueAfter(texts, "UPI ID:") ?: ""
        // Read for THIS payment and carried through the capture chain. It used to live in a
        // field, which was safe only while payments were nine seconds apart: back-to-back
        // captures would let the next screen's block overwrite this one's before the reader
        // activity picked it up, and the RRN would be filed with another payment's details.
        val detailsJson = runCatching {
            val f = paytmDetailFields(texts)
            if (f.isEmpty()) "" else org.json.JSONObject(f as Map<*, *>).toString()
        }.getOrDefault("")
        // SCREENSHOT FIRST, SCROLL ONLY IF WE HAVE TO.
        //
        // Two swipes always ran before the screenshot, on the assumption that the Copy link is
        // below the fold. Often it is not — on a short payment screen it is visible the moment
        // the detail opens — and the pair of gestures costs about 1.1 seconds of every single
        // capture. At six payments in one minute (live burst 2026-08-18 20:52) that second is
        // the difference between clearing the minute and falling behind it.
        //
        // So the cheap attempt goes first and the scroll becomes the fallback, which also turns
        // "no Copy link on screen" from a dead end into a retry.
        //
        // THE NODE ALREADY SAID WHERE IT IS. We only reach this line with real bounds now, so the
        // Copy link's own rectangle is the target — no screenshot, no colour matching, no chance
        // of landing on a button that merely happens to be blue and in the same column. The pixel
        // search below survives only as the fallback for a laid-out node whose tap does not take.
        // TAP A SCREEN THAT HAS STOPPED MOVING.
        //
        // A payment detail animates in, and the first accessibility event arrives while it is
        // still sliding. Bounds read then are correct for that instant and stale a moment later,
        // so the tap lands where the Copy link WAS and nothing reaches the clipboard. Live proof,
        // 2026-08-21 17:52: taps at y=1659 and y=1610 — both on a screen still settling — returned
        // got=null, while the two that followed a scroll (and so hit a settled screen at y=1485)
        // both captured. Same code, same layout; the only difference was motion.
        //
        // So re-read the row after a short delay and only tap once it has held still. Cheap
        // compared with losing the payment: a settled screen reports the same bounds twice.
        tapCopyWhenSettled(masked, amount, payer, upiId, paidAt, detailsJson, cRect, 0)
    }

    /**
     * Re-read the RRN row until its position stops changing, then tap its Copy link.
     *
     * @param last  the bounds seen on the previous pass
     * @param tries how many times we have already re-read; bounded so a screen that never
     *              settles fails loudly instead of looping.
     */
    private fun tapCopyWhenSettled(
        masked: String, amount: String, payer: String, upiId: String, paidAt: String,
        detailsJson: String, last: Rect, tries: Int,
    ) {
        main.postDelayed({
            val root = rootInActiveWindow
            if (root == null) { noteCaptureFail("screen went away before the Copy tap"); onPaytmCaptureDone(applicationContext); return@postDelayed }
            val now = ArrayList<Pair<String, AccessibilityNodeInfo>>()
            flattenAll(root, now)
            val nowTexts = now.map { it.first }

            val idx = nowTexts.indexOfFirst { it.equals("RRN", true) }
            val mNode = if (idx < 0) null else now.drop(idx + 1).firstOrNull { maskedRrn.containsMatchIn(it.first) }?.second
            val mRect = Rect().also { mNode?.getBoundsInScreen(it) }
            val copy = if (mNode == null || mRect.height() <= 0) null else now.asSequence()
                .filter { it.first.trim().equals("Copy", true) }
                .mapNotNull { (_, n) ->
                    val r = Rect().also { n.getBoundsInScreen(it) }
                    if (r.height() > 0) n to r else null
                }
                .filter { (_, r) -> kotlin.math.abs(r.exactCenterY() - mRect.exactCenterY()) <= mRect.height() * 1.5f }
                .minByOrNull { (_, r) -> kotlin.math.abs(r.exactCenterY() - mRect.exactCenterY()) }

            if (copy == null) {
                if (tries < SETTLE_TRIES) tapCopyWhenSettled(masked, amount, payer, upiId, paidAt, detailsJson, last, tries + 1)
                else { noteCaptureFail("RRN row never settled on screen"); onPaytmCaptureDone(applicationContext) }
                return@postDelayed
            }
            val r = copy.second
            // Held still since the last look? Then it is safe to tap.
            if (kotlin.math.abs(r.exactCenterY() - last.exactCenterY()) < 2f && r.exactCenterY() > 0f) {
                Log.d(TAG, "RRN row: masked=$masked amt=$amount payer=$payer -> tapping Copy at " +
                    "(${r.exactCenterX().toInt()},${r.exactCenterY().toInt()}) settled after $tries re-read(s)")
                tapAndRead(r.exactCenterX(), r.exactCenterY(), masked, amount, payer, upiId, paidAt, detailsJson)
            } else if (tries < SETTLE_TRIES) {
                tapCopyWhenSettled(masked, amount, payer, upiId, paidAt, detailsJson, r, tries + 1)
            } else {
                // Still drifting after the budget — tap the latest position rather than drop the
                // payment. A late tap sometimes lands; a skipped one never does.
                Log.w(TAG, "RRN row still moving after $tries re-reads; tapping anyway")
                tapAndRead(r.exactCenterX(), r.exactCenterY(), masked, amount, payer, upiId, paidAt, detailsJson)
            }
        }, SETTLE_MS)
    }

    /**
     * Look at the scrolled detail again, and keep looking for a moment before giving up.
     *
     * A single look loses the race whenever the re-layout lands after the gesture callback: the
     * capture then makes no further move and the payment holds the queue slot for the full
     * CAPTURE_DEADLINE_MS. That silence — not the capture itself — is what put 18-22s between
     * payments while each successful capture took 2.4s.
     */
    private fun rereadAfterCopyScroll(autoMode: Boolean, tries: Int) {
        val root = rootInActiveWindow
        if (root != null) {
            val again = ArrayList<Pair<String, AccessibilityNodeInfo>>()
            flatten(root, again)
            val againTexts = again.map { it.first }
            if (againTexts.any { it.equals("RRN", true) }) { handleDetail(again, againTexts, autoMode); return }
        }
        // Not laid out yet. Another look costs 350ms; the alternative costs eight seconds.
        if (tries + 1 < COPY_REREAD_TRIES) {
            main.postDelayed({ rereadAfterCopyScroll(autoMode, tries + 1) }, COPY_REREAD_MS)
        } else {
            // Out of looks. Say so rather than going quiet — a payment that ends here is one the
            // deadline would otherwise have swallowed with no counter to show for it.
            Log.d(TAG, "detail did not re-render after the scroll; leaving it for the sweep")
        }
    }

    // ------------------------------------------------------------------ list

    private fun handleList(ordered: List<Pair<String, AccessibilityNodeInfo>>) {
        val count = parseCount(ordered.map { it.first })
        if (count < 0) return // not the payments list (no "N Payments" header)
        if (sweeping) return  // a sweep is already running; the pump drives it
        // The notification queue is draining: each queued payment opens its own detail directly,
        // which is both faster and exact. A sweep started now would tap a row out from under it.
        // forceResweep is sticky, so the sweep still runs once the queue is empty.
        if (captureBusy || pendingCaptureCount() > 0) return

        // A BACKFILL BELONGS ON THE FULL LIST, NOT THE HOME SCREEN.
        //
        // Paytm's home screen carries a five-row preview of today's payments under a summary
        // ("₹7,08,620 from 205 Payment, Today"). parseCount matches that summary, so a sweep
        // started here walks five rows and reports itself complete — which is fine for keeping up
        // with new payments and useless for recovering 205 of them. The summary is itself the link
        // to the full list, so a deep sweep taps it and lets the list's own event start the sweep.
        //
        // Matched on the trailing ", Today", which only the home summary has; the full list's own
        // header reads "Total ₹… from 205 Payments" and must not send us round again.
        if (deepSweep && !openedFullList) {
            val summary = ordered.firstOrNull { homeSummaryRx.containsMatchIn(it.first) }
            if (summary != null) {
                // Once. The home screen fires several events in a row and each one was opening the
                // list again, stacking duplicate screens under the sweep.
                openedFullList = true
                Log.d(TAG, "auto: deep sweep on the home screen -> opening the full payments list")
                clickNode(summary.second)
                return
            }
        }

        // AND IT MUST NOT START UNTIL THAT LIST IS ACTUALLY ON SCREEN.
        //
        // Tapping the summary above only *asks* for the full list; Paytm takes a beat to render
        // it. The next accessibility event arrives ~600ms later with the home screen still up, and
        // the baseline sweep below then ran against the home screen's five-row preview — visiting
        // 5 rows of 268 and reporting itself complete (2026-08-21, twice). `deepSweep` stays armed
        // until startSweep claims it, so simply waiting here costs nothing and the sweep begins on
        // the real list. The home summary is the tell: only the home screen carries ", Today".
        if (deepSweep && ordered.any { homeSummaryRx.containsMatchIn(it.first) }) {
            Log.d(TAG, "auto: deep sweep armed but the full list has not rendered yet -> waiting")
            return
        }

        // On-demand "Get RRN": re-sweep the currently-visible rows now (dedupe still skips
        // ones we already captured, so this only retries the still-missing RRNs).
        if (forceResweep) { forceResweep = false; baselineDone = false }

        if (!baselineDone) {
            baselineDone = true
            handledCount = count
            Log.d(TAG, "auto: enabled (count=$count); sweeping visible rows")
            startSweep()
            return
        }
        if (count > handledCount) {
            Log.d(TAG, "auto: ${count - handledCount} new payment(s) (count=$count); sweeping")
            handledCount = count
            startSweep()
        }
    }

    private fun startSweep() {
        if (sweeping) return
        sweeping = true
        // CLAIM THE DEEP-SWEEP REQUEST FOR THIS SWEEP. The request used to be read straight off
        // `deepSweep` and cleared in endSweep, so a sweep that was ALREADY running when the
        // backfill was armed consumed the flag on its way out and the real sweep then ran with the
        // ordinary four-scroll budget — four rows of 205 (2026-08-21). Binding it here means the
        // depth belongs to the sweep that actually walks the list.
        sweepIsDeep = deepSweep
        deepSweep = false
        sweptKeys.clear()
        sweepScrolls = 0
        oldStreak = 0
        sweepStallScrolls = 0
        lastRowKeys = emptySet()
        openNext()
    }

    private fun openNext() {
        if (!sweeping) return
        val root = rootInActiveWindow
        val ordered = ArrayList<Pair<String, AccessibilityNodeInfo>>()
        if (root != null) flatten(root, ordered)
        var count = parseCount(ordered.map { it.first })
        if (count < 0) {
            // A MISSING HEADER AFTER A SCROLL IS NOT A LOST LIST.
            //
            // parseCount recognises the payments list by its "… from N Payments" header, which
            // sits above the rows and leaves the viewport as soon as the sweep scrolls. Reading
            // that as "we are no longer on the list" ended every deep sweep one scroll in — the
            // precise moment it began reaching the backlog it exists to rescue. If payment rows
            // are on screen and this sweep has already scrolled, the list is still there; the
            // header is simply above us.
            val rowsNow = findRowNodes(ordered)
            if (rowsNow.isNotEmpty()) {
                // Payment rows on screen ARE the list. Requiring a scroll to have happened first
                // meant the very first return from a detail on the full list still failed the
                // header test and ended the sweep at four rows of 205 (2026-08-21).
                count = handledCount
            } else { // genuinely not settled (a detail is still closing) -> retry
                // The full payments list is a WebView that loads its rows lazily: scroll it and
                // the next screenful arrives well after the gesture ends. Four seconds of patience
                // was enough for the native home-screen list and far too little here — the deep
                // sweep died two scrolls in, at row 7 of 100 (2026-08-21). A backfill waits.
                val patience = if (sweepIsDeep) 25 else 8
                if (openRetries++ < patience) main.postDelayed({ openNext() }, 500)
                else endSweep(handledCount, "list never settled")
                return
            }
        }
        openRetries = 0
        val rows = findRowNodes(ordered)

        // SKIP WHAT WE ALREADY HOLD WITHOUT OPENING IT.
        //
        // Opening a row to discover it is already captured costs about 4.5 seconds of screen
        // driving and learns nothing. It was the entire cost of a backfill: on a 478-row list
        // nearly every row is already held, so the sweep spent ~40 minutes re-reading payments
        // it had (2026-08-22). RrnStore now remembers the row's own text on the way past, so the
        // second and every later pass recognises it from the list and moves on.
        var next: Pair<String, AccessibilityNodeInfo>? = null
        var skippedKnown = 0
        for (cand in rows) {
            if (cand.first in sweptKeys) continue
            if (RrnStore.isRowCaptured(cand.first)) {
                // Mark it visited so the boundary and scroll logic still see it as dealt with.
                sweptKeys.add(cand.first); skippedKnown++; continue
            }
            next = cand; break
        }
        if (skippedKnown > 0) Log.d(TAG, "auto: skipped $skippedKnown already-captured row(s) without opening")
        if (next == null) {
            // THE LIST IS PAGINATED, NOT INFINITE-SCROLL. EXPAND IT BEFORE SCROLLING PAST IT.
            //
            // Paytm groups the payments by date and renders only the first handful of each group,
            // behind a "View More" button. No amount of scrolling reveals the rest — scrolling
            // simply carries the sweep past the end of the loaded page and into the NEXT date
            // group, which is why a 478-row backfill kept ending at exactly seven rows visited
            // with the list "not advancing" (2026-08-22). It was advancing; there was nothing
            // more of that day loaded to advance to.
            //
            // So when the visible rows run out, look for the expander first and press it. Not
            // counted as a scroll and it clears the stall counter, because loading more rows is
            // progress — the opposite of the stuck list that counter exists to detect. clickNode
            // refuses money controls, so this cannot press anything that moves money.
            val viewMore = ordered.firstOrNull {
                val t = it.first.trim()
                t.equals("View More", true) || t.equals("View more", true)
            }
            if (viewMore != null) {
                val vr = Rect().also { viewMore.second.getBoundsInScreen(it) }
                if (vr.height() > 0 && clickNode(viewMore.second)) {
                    Log.d(TAG, "auto: list is paginated -> pressing \"View More\" for the rest of the day")
                    sweepStallScrolls = 0
                    lastRowKeys = emptySet()
                    main.postDelayed({ openNext() }, LIST_RERENDER_MS)
                    return
                }
            }

            // NEVER SCROLL A SCREEN THIS SWEEP CANNOT IDENTIFY.
            //
            // Reaching here with no payment rows at all means the sweep is no longer looking at a
            // payments list. Scrolling anyway is what put a backfill on the bank-settlement tab
            // for 58 scrolls, a few hundred pixels from "Settle Now" (2026-08-21). Stop instead.
            if (rows.isEmpty() && ordered.any { settlementScreenRx.containsMatchIn(it.first) }) {
                endSweep(count, "left the payments list for the settlement screen")
                return
            }

            // A LIST THAT REPORTS THE SAME ROWS AFTER A SCROLL HAS STOPPED ADVANCING.
            //
            // The full list is a WebView, and when its own scroll action stops working the swipe
            // fallback moves pixels without changing what the accessibility tree reports. Spending
            // the remaining budget on that is pure waste, so a few identical reads end the sweep
            // with a reason the dashboard can show instead of a silent "complete".
            val keysNow = rows.map { it.first }.toSet()
            if (keysNow.isNotEmpty() && keysNow == lastRowKeys) sweepStallScrolls++ else sweepStallScrolls = 0
            lastRowKeys = keysNow
            if (sweepStallScrolls >= MAX_STALL_SCROLLS) {
                endSweep(count, "the list stopped advancing after $sweepScrolls scroll(s)")
                return
            }

            // Everything on screen has been visited. Scroll and keep going — the payments this
            // sweep exists to rescue are exactly the ones a burst pushed below the fold.
            val scrollLimit = if (sweepIsDeep) DEEP_SWEEP_SCROLLS else MAX_SWEEP_SCROLLS
            if (sweepScrolls < scrollLimit) {
                sweepScrolls++
                Log.d(TAG, "auto: visible rows done -> scrolling for more ($sweepScrolls/$scrollLimit)")
                // SCROLL THE LIST BY ITS OWN ACTION, NOT BY A SWIPE OVER IT.
                //
                // The full payments list is a WebView. A swipe gesture lands on it and it does
                // move, but what the accessibility tree reports afterwards is the same set of
                // rows — so the sweep re-scrolled against a list that never advanced, spending all
                // thirty scrolls in ten seconds and visiting eight rows of 205 (2026-08-21).
                // ACTION_SCROLL_FORWARD is handled by the scrolling container itself and moves it
                // by exactly one viewport, which is what the row scan needs. The swipe stays as
                // the fallback for the native list, which has no scrollable node to find.
                // SWIPE. NOT ACTION_SCROLL_FORWARD — on this screen that action is a tab change.
                //
                // The theory was that the scrolling container's own action moves it by exactly one
                // viewport. The measurement says otherwise: Paytm's Payments tab exposes NO
                // scrollable node at all (uiautomator, 2026-08-22), so the "largest scrollable"
                // this ever found was the ViewPager holding Payments and Bank Settlements — and
                // scrolling a pager forward means NEXT PAGE. Every observed use flipped the tab:
                // it returned true once, the sweep landed on the settlement screen, and every
                // later call returned false because no list remained. Restricting the search to
                // laid-out, taller-than-wide nodes did not help, because a full-screen pager is
                // exactly that (2026-08-22, tested on the 478-row list).
                //
                // So it has never once advanced this list, and every time it fires it walks the
                // sweep onto a screen carrying "Settle Now". A swipe cannot change tabs. If the
                // WebView does not re-render after one, the stall detector above ends the sweep
                // after three unchanged reads — a sweep that stops is strictly better than a
                // sweep that drives the settlement screen.
                // AND GIVE THE LIST TIME TO RE-RENDER BEFORE READING IT.
                //
                // 700ms was inherited from the native home-screen list. The full list is a
                // WebView that re-lays-out well after the gesture ends, so reading this soon
                // returns the rows that were already there — indistinguishable from a list that
                // has stopped moving. Measured 2026-08-22: the first swipe genuinely advanced
                // (rows 5-7 appeared), then three reads at 1.27s intervals all came back
                // unchanged and the stall detector ended a 478-row sweep at seven rows. The
                // gesture was working; the clock was wrong.
                swipeUp { main.postDelayed({ openNext() }, LIST_RERENDER_MS) }
                return
            }
            endSweep(count, "reached the sweep depth limit")
            return
        }
        val (key, node) = next
        sweptKeys.add(key)
        openingRowKey = key
        autoNavigating = true
        backScheduled = false
        detailReached = false
        lastOpenResult = R_UNKNOWN
        val gen = ++openGen
        val rb = Rect().also { node.getBoundsInScreen(it) }
        Log.d(TAG, "auto: opening row ${sweptKeys.size} (${if (node.isClickable) "ACTION_CLICK" else "tap"} @ ${rb.exactCenterX().toInt()},${rb.exactCenterY().toInt()})")
        clickNode(node)
        // Watchdog: if the tap never opened a detail, skip this row and continue. The row is
        // already marked visited, so the next call moves on rather than re-tapping it.
        main.postDelayed({
            if (gen == openGen && sweeping && !detailReached) {
                Log.w(TAG, "auto: row did not open; skipping")
                openNext()
            }
        }, 4500)
    }

    /**
     * End the sweep and put the list back where the merchant left it.
     *
     * A sweep that scrolled must scroll back: Paytm shows new payments at the TOP, so a list left
     * scrolled down would leave both the merchant and the next sweep looking at old rows.
     */
    private fun endSweep(count: Int, why: String) {
        sweeping = false
        // A deep sweep is a one-shot request, not a mode: the next ordinary sweep must go back to
        // stopping at the boundary or every new payment would re-walk the entire day.
        if (sweepIsDeep) { sweepIsDeep = false; openedFullList = false; Log.d(TAG, "auto: deep sweep finished") }
        handledCount = count
        Log.d(TAG, "auto: sweep complete ($why; ${sweptKeys.size} rows visited)")
        scrollBackToTop(sweepScrolls)
    }

    private fun scrollBackToTop(remaining: Int) {
        if (remaining <= 0) return
        swipeDown { scrollBackToTop(remaining - 1) }
    }

    /**
     * One row finished; decide whether to continue down the list.
     *
     * AN ALREADY-CAPTURED ROW IS NO LONGER THE END OF THE SWEEP. It used to be: the list was
     * assumed to be strictly newest-first, so the first familiar payment meant everything below it
     * was familiar too. Live on 2026-08-17 that assumption cost two real payments — the count rose
     * to 4 and then 5, the sweep opened row #0 both times, found a payment it already had, and
     * stopped, so neither new RRN was ever captured:
     *
     *     auto: 1 new payment(s) (count=4); sweeping
     *     auto: opening row #0 (ACTION_CLICK @ 433,1138)
     *     auto: reached already-captured txn -> sweep complete
     *
     * Paytm's summary total updates before its rows re-render, so row #0 can still be the previous
     * payment while a newer one exists further down (or not yet drawn). Re-visiting a captured row
     * costs about two seconds and stores nothing (RrnStore dedupes), whereas stopping early loses
     * money silently — so the sweep now steps over familiar rows and only gives up after
     * STOP_AFTER_OLD of them in a row, or when the visible rows run out.
     */
    private fun onReturned() {
        if (!sweeping) return
        // EITHER OUTCOME MEANS THIS ROW IS DEALT WITH — captured just now, or already held. Both
        // are worth remembering, because both make re-opening it on the next pass pointless.
        if (lastOpenResult == R_OLD || lastOpenResult == R_NEW) RrnStore.recordRow(openingRowKey)
        openingRowKey = null

        if (lastOpenResult == R_OLD) {
            oldStreak++
            if (!sweepIsDeep && oldStreak >= STOP_AFTER_OLD) {
                endSweep(handledCount, "$oldStreak already-captured rows in a row")
                return
            }
            Log.d(TAG, "auto: row already captured; continuing ($oldStreak/$STOP_AFTER_OLD)")
        } else oldStreak = 0
        openNext()
    }

    /** Paytm's "… from N Payments" total, or -1 if this isn't the payments list. */
    private fun parseCount(texts: List<String>): Int {
        for (t in texts) countRx.find(t)?.let {
            return it.groupValues[1].replace(",", "").toIntOrNull() ?: -1
        }
        return -1
    }

    /**
     * The transaction rows on Paytm's payments list, top to bottom — as NODES, not coordinates.
     *
     * This used to return (screen-centre X, centre-Y of the row's time text) and tap that point.
     * On a live device (2026-08-17) that aimed at y=1992 for a row whose clickable ViewGroup spans
     * [1988..2139]: the point landed in a non-clickable child at the row's top edge, the tap did
     * nothing, and the sweep logged "row #0 did not open; skipping" for a payment that opens
     * perfectly well — a tap 70px lower reached its detail screen on the first try.
     *
     * A coordinate is a guess about layout; the row itself is the target. So the time text is only
     * used to FIND the row, and what comes back is its nearest clickable ancestor, which
     * clickNode() activates with ACTION_CLICK (falling back to a real tap at that node's own
     * centre). Rows are deduped by their bounds because several child texts match the time.
     */
    private fun findRowNodes(ordered: List<Pair<String, AccessibilityNodeInfo>>): List<Pair<String, AccessibilityNodeInfo>> {
        val out = ArrayList<Triple<Int, String, AccessibilityNodeInfo>>()
        val seen = HashSet<Int>()
        val keys = HashSet<String>()
        for ((t, n) in ordered) {
            if (!timeRx.containsMatchIn(t)) continue
            var target: AccessibilityNodeInfo? = n
            var depth = 0
            while (target != null && !target.isClickable && depth < 6) { target = target.parent; depth++ }
            val node = target ?: continue
            val r = Rect().also { node.getBoundsInScreen(it) }
            if (r.width() <= 0 || r.height() <= 0) continue
            if (!seen.add(r.top / 10)) continue
            val key = rowKey(node)
            if (!keys.add(key)) continue
            out.add(Triple(r.top, key, node))
        }
        return out.sortedBy { it.first }.map { it.second to it.third }
    }

    /**
     * What a row says about itself — time, amount, payer — as its identity across a scroll.
     *
     * Deliberately the row's own text and not its position: a scroll changes every position and
     * nothing else, so a positional key made scrolling impossible. Two rows sharing this key are
     * the same payment; the masked-reference ledger still decides what is actually captured.
     */
    private fun rowKey(node: AccessibilityNodeInfo): String {
        val parts = ArrayList<Pair<String, AccessibilityNodeInfo>>()
        flatten(node, parts)
        return parts.joinToString("|") { it.first.trim() }.take(140)
    }

    /**
     * Leave a bridge-opened payment NOW, because its RRN is in hand.
     *
     * Called from the clipboard reader the instant the value is stored. Three things have to
     * happen together: the per-screen busy gate is cleared (it exists to stop us re-firing on the
     * SAME screen, and must not tax the NEXT payment), the pending fixed-delay return is
     * superseded, and a fresh return starts immediately. `returnFromDetail` waits while our own
     * reader activity is still foreground, so this can safely be called before it finishes.
     */
    private fun leavePaytmDetailNow() {
        onNewCaptureStarting()
        // A detail the SWEEP opened has its own return path (goBackToList) — don't double-drive it.
        if (autoNavigating) return
        // STILL PAYMENTS WAITING? Then don't press BACK at all: the next one's notification intent
        // navigates straight to its own screen, so a BACK here would only race that navigation —
        // and cost the better part of a second per payment for nothing. The last payment in the
        // queue is the one that puts the phone back on the list.
        if (pendingCaptureCount() > 0) return
        returnFromDetail(0)
    }

    /**
     * Drop the state that belonged to the payment we have just finished with.
     *
     * Both halves matter once captures run back-to-back: a pending return armed for the previous
     * payment would otherwise fire while the next one is on screen and press BACK out of a capture
     * in progress, and the per-screen busy gate — which exists only to stop us re-firing on the
     * SAME screen — would tax the next payment for four and a half seconds it does not owe.
     */
    private fun onNewCaptureStarting() {
        detailBusyUntil = 0L
        bridgeGen++
        bridgeBackScheduled = false
    }

    private fun goBackToList() {
        autoNavigating = false
        backScheduled = false
        backAttempts = 0
        waitChecks = 0
        pressBackThenVerify()
    }

    private fun pressBackThenVerify() {
        performGlobalAction(GLOBAL_ACTION_BACK)
        main.postDelayed({ verifyOnList() }, 700)
    }

    /**
     * Leave a detail screen this agent opened from a notification.
     *
     * Independent of the sweep's own return path, because there is no sweep in this case — the
     * intent took us straight to one payment. Presses BACK up to three times: Paytm's detail is a
     * WebView that sometimes consumes the first press for its own history. Waits while our own
     * clipboard-reader activity is in the foreground, so a BACK can never kill it before it has
     * read the RRN.
     */
    private fun returnFromDetail(attempt: Int, gen: Int = bridgeGen) {
        // Superseded: this return was armed for a payment we have already left.
        if (gen != bridgeGen) return
        val root = rootInActiveWindow
        val texts = ArrayList<Pair<String, AccessibilityNodeInfo>>().also { if (root != null) flatten(root, it) }.map { it.first }
        val pkg = root?.packageName?.toString()
        // Our reader is on screen: give it time to finish rather than pressing BACK through it.
        if (pkg == packageName && attempt < 8) {
            main.postDelayed({ returnFromDetail(attempt + 1, gen) }, 400); return
        }
        val onDetail = texts.any { it.equals("RRN", true) } ||
            texts.any { it.equals("UPI Transaction ID", true) }
        if (!onDetail) { bridgeBackScheduled = false; return }        // already back on the list
        if (attempt >= 4) {
            bridgeBackScheduled = false
            Log.w(TAG, "auto: still on the payment detail after $attempt tries; leaving it")
            return
        }
        Log.d(TAG, "auto: leaving the payment detail (BACK ${attempt + 1})")
        performGlobalAction(GLOBAL_ACTION_BACK)
        main.postDelayed({ returnFromDetail(attempt + 1, gen) }, 800)
    }

    private fun verifyOnList() {
        if (!sweeping) return
        val root = rootInActiveWindow
        val ordered = ArrayList<Pair<String, AccessibilityNodeInfo>>()
        if (root != null) flatten(root, ordered)
        val texts = ordered.map { it.first }
        val onDetail = texts.any { it.equals("RRN", true) }
        // ROWS PROVE THE LIST, THE HEADER ONLY CONFIRMS IT.
        //
        // This asked parseCount alone, so returning from a payment only counted as "back on the
        // list" while the "… from N Payments" header happened to be in view. On the full payments
        // screen it is not: the header sits above rows the sweep has already scrolled past, so the
        // very first return failed and the sweep ended with "could not get back to the list; 1 rows
        // visited" — on a list of 100 payments (2026-08-21). A screen showing payment rows IS the
        // list. The detail check goes first so a detail screen can never be mistaken for one.
        val onList = !onDetail && (parseCount(texts) >= 0 || findRowNodes(ordered).isNotEmpty())
        val pkg = root?.packageName?.toString()
        when {
            onList -> onReturned() // reached a payments list — continue the sweep
            onDetail && backAttempts < 3 -> { backAttempts++; pressBackThenVerify() } // WebView ate the BACK
            (pkg == "com.paytm.business" || pkg == "net.one97.paytm.merchant" || pkg == packageName) && waitChecks < 6 -> {
                waitChecks++; main.postDelayed({ verifyOnList() }, 500) // reader/transition — wait it out
            }
            else -> {
                Log.w(TAG, "auto: could not return to payments list; pausing sweep")
                endSweep(handledCount, "could not get back to the list")
            }
        }
    }

    private fun tap(x: Float, y: Float) {
        // THE LAST LINE OF DEFENCE, and the one that would have prevented 2026-08-21. Every
        // gesture this service dispatches goes through here, so a single check covers the RRN
        // Copy tap, the sweep's row taps and any future caller.
        moneyControlAt(x, y)?.let { label ->
            Log.w(TAG, "REFUSING to tap (${x.toInt()},${y.toInt()}): \"$label\" is under it")
            noteCaptureFail("refused to tap a money control (\"$label\")")
            return
        }
        val path = Path().apply { moveTo(x, y) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 60))
            .build()
        dispatchGesture(gesture, null, null)
    }

    // ------------------------------------------------------------- capturing

    private fun valueAfter(texts: List<String>, label: String): String? {
        val i = texts.indexOfFirst { it.trim().equals(label, true) }
        if (i < 0) return null
        // Return the next real value, skipping blanks and other labels ("X:").
        for (j in i + 1 until texts.size) {
            val v = texts[j].trim()
            if (v.isNotBlank() && !v.endsWith(":")) return v
        }
        return null
    }

    // scrollListForward() USED TO LIVE HERE and has been deleted rather than left unused.
    // It performed ACTION_SCROLL_FORWARD on the largest scrollable, which on Paytm's payments
    // screen is the tab pager — see the note at its former call site. Leaving a working-looking
    // helper in place invites the next person to call it again.

    /**
     * A LONGER SWIPE, FOR THE DETAIL SCREEN ONLY.
     *
     * The RRN block always sits below the fold of a Paytm payment detail, and the standard swipe
     * (45% of the screen, tuned for the list) often needs two passes to bring it up — each pass
     * costing a gesture plus a re-read, about 1.2s. One 70% swipe usually lands it in a single
     * move. Kept separate from swipeUp so the payments-list sweep, which was measured and tuned
     * against the shorter throw, is untouched.
     */
    private fun swipeUpFar(onDone: () -> Unit) {
        val dm = resources.displayMetrics
        val x = dm.widthPixels / 2f
        val path = Path().apply {
            moveTo(x, dm.heightPixels * 0.84f)
            lineTo(x, dm.heightPixels * 0.14f)
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 260))
            .build()
        val cb = object : GestureResultCallback() {
            override fun onCompleted(d: GestureDescription?) { main.postDelayed(onDone, 260) }
            override fun onCancelled(d: GestureDescription?) { main.postDelayed(onDone, 260) }
        }
        if (!dispatchGesture(gesture, cb, null)) main.postDelayed(onDone, 260)
    }

    private fun swipeUp(onDone: () -> Unit) {
        val dm = resources.displayMetrics
        val x = dm.widthPixels / 2f
        val path = Path().apply {
            moveTo(x, dm.heightPixels * 0.72f)
            lineTo(x, dm.heightPixels * 0.27f)
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 250))
            .build()
        val cb = object : GestureResultCallback() {
            override fun onCompleted(d: GestureDescription?) { main.postDelayed(onDone, 300) }
            override fun onCancelled(d: GestureDescription?) { main.postDelayed(onDone, 300) }
        }
        if (!dispatchGesture(gesture, cb, null)) main.postDelayed(onDone, 300)
    }

    private fun swipeDown(onDone: () -> Unit) {
        val dm = resources.displayMetrics
        val x = dm.widthPixels / 2f
        val path = Path().apply {
            moveTo(x, dm.heightPixels * 0.27f)
            lineTo(x, dm.heightPixels * 0.72f)
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 250))
            .build()
        val cb = object : GestureResultCallback() {
            override fun onCompleted(d: GestureDescription?) { main.postDelayed(onDone, 300) }
            override fun onCancelled(d: GestureDescription?) { main.postDelayed(onDone, 300) }
        }
        if (!dispatchGesture(gesture, cb, null)) main.postDelayed(onDone, 300)
    }

    private fun captureViaScreenshot(
        masked: String, amount: String, payer: String, upiId: String, paidAt: String,
        detailsJson: String, copyX: Float, bandX0: Int, bandX1: Int, scrolled: Boolean
    ) {
        // Retry this same capture with the screen scrolled down, or give up if we already have.
        fun scrollAndRetry(why: String) {
            if (scrolled) { noteCaptureFail(why); onPaytmCaptureDone(applicationContext); return }
            Log.d(TAG, "$why -> scrolling and looking again")
            swipeUp { swipeUp {
                captureViaScreenshot(masked, amount, payer, upiId, paidAt, detailsJson, copyX, bandX0, bandX1, true)
            } }
        }
      runCatching {
        takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
            override fun onSuccess(result: ScreenshotResult) {
                val bmp = runCatching {
                    Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
                        ?.copy(Bitmap.Config.ARGB_8888, false)
                }.getOrNull()
                result.hardwareBuffer.close()
                // EVERY DEAD END RELEASES THE QUEUE. These paths used to return silently, and the
                // payment then held the capture slot for the full deadline — one unreadable screen
                // cost the same as three real captures during a burst.
                if (bmp == null) {
                    Log.w(TAG, "screenshot bitmap null")
                    scrollAndRetry("screenshot unreadable"); return
                }
                val y = findCopyRowY(bmp, bandX0, bandX1)
                bmp.recycle()
                if (y <= 0f) {
                    scrollAndRetry("no Copy link on screen"); return
                }
                Log.d(TAG, "found Copy at ($copyX,$y) -> tapping")
                tapAndRead(copyX, y, masked, amount, payer, upiId, paidAt, detailsJson)
            }
            override fun onFailure(errorCode: Int) {
                Log.w(TAG, "takeScreenshot failed: $errorCode")
                scrollAndRetry("screenshot failed ($errorCode)")
            }
        })
      }.onFailure {
          Log.w(TAG, "takeScreenshot threw: ${it.message}")
          scrollAndRetry("screenshot threw")
      }
    }

    private fun findCopyRowY(bmp: Bitmap, bandX0: Int, bandX1: Int): Float {
        val x0 = bandX0.coerceIn(0, bmp.width - 1)
        val x1 = bandX1.coerceIn(x0 + 1, bmp.width)
        val w = (x1 - x0).coerceAtLeast(1)
        val h = bmp.height
        val rowPixels = IntArray(w)

        var clusterStart = -1
        var lastStart = -1
        var lastEnd = -1
        for (y in 0 until h) {
            bmp.getPixels(rowPixels, 0, w, x0, y, w, 1)
            var blue = 0
            for (p in rowPixels) {
                val r = (p shr 16) and 0xff
                val g = (p shr 8) and 0xff
                val b = p and 0xff
                if (b > 150 && b - r > 55 && b - g > 15) blue++
            }
            if (blue >= 6) {
                if (clusterStart < 0) clusterStart = y
            } else if (clusterStart >= 0) {
                lastStart = clusterStart; lastEnd = y - 1; clusterStart = -1
            }
        }
        if (clusterStart >= 0) { lastStart = clusterStart; lastEnd = h - 1 }
        // A "Copy" LINK IS A LINE OF TEXT, NOT A BUTTON. Any blue run taller than a line of text
        // is a filled control — Paytm's "Settle Now" is 96px tall and its avatar circles 66px —
        // and accepting one is how this returned the centre of a money-moving button as the
        // place to tap (2026-08-21). Only the primary path's node bounds are trusted now; this
        // survives as a fallback, and a fallback that can hit "Settle Now" is worse than none.
        val maxLinkHeight = (resources.displayMetrics.density * 32f).toInt()
        if (lastStart >= 0 && (lastEnd - lastStart) > maxLinkHeight) {
            Log.w(TAG, "ignoring a ${lastEnd - lastStart}px blue block — too tall to be a Copy link")
            return -1f
        }
        return if (lastStart >= 0) ((lastStart + lastEnd) / 2f) else -1f
    }

    private fun tapAndRead(
        x: Float, y: Float, masked: String, amount: String, payer: String, upiId: String, paidAt: String,
        detailsJson: String
    ) {
        val path = Path().apply { moveTo(x, y) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 60))
            .build()
        val fired = dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(d: GestureDescription?) {
                main.postDelayed({ launchReader(masked, amount, payer, upiId, paidAt, detailsJson) }, COPY_SETTLE_MS)
            }
            override fun onCancelled(d: GestureDescription?) {
                Log.w(TAG, "tap cancelled")
                noteCaptureFail("copy tap cancelled")
                onPaytmCaptureDone(applicationContext)
            }
        }, null)
        if (!fired) Log.w(TAG, "dispatchGesture returned false")
    }

    /**
     * WHAT THE PAYTM DETAIL SCREEN SAYS, beyond the RRN.
     *
     * GPay captures land with a full block — payer, method, customer-paid vs amount-you-get, both
     * references — and the dashboard offers a "Details" expansion for them. Paytm captures landed
     * with an amount and a reference and nothing else, so the same payment read as thinner on the
     * screen that is supposed to explain it (merchant report 2026-08-17).
     *
     * Paytm states plenty; it just labels it three different ways, so all three are handled:
     *   "Counter Name (POS ID): DEFAULT"  — label and value in ONE node, split on the colon
     *   "Payment Amount₹ 1"               — label and value fused, split at the currency symbol
     *   "Name:" then "Kush Desai"         — label node followed by its value node
     * Keys are snake_case so they read the same as the GPay block on the dashboard.
     */
    private fun paytmDetailFields(texts: List<String>): Map<String, String> {
        fun key(label: String) = label.trim().trimEnd(':').lowercase()
            .replace(Regex("\\(.*?\\)"), " ")                 // drop parentheticals: "(POS ID)"
            .replace(Regex("[^a-z0-9]+"), "_").trim('_')
        // Only fields worth showing an operator; anything else on that screen is chrome.
        val wanted = setOf(
            "payment_amount", "amount_to_be_settled", "paid_at", "paid_using", "counter_name",
            "order_id", "response_code", "name", "payment_option", "comment", "customer_details",
        )
        val out = LinkedHashMap<String, String>()
        for ((i, raw) in texts.withIndex()) {
            val t = raw.trim()
            if (t.isEmpty() || t.length > 120) continue
            // 1) "Label: value" in one node.
            val colon = t.indexOf(':')
            if (colon in 1 until t.length - 1) {
                val k = key(t.substring(0, colon))
                val v = t.substring(colon + 1).trim()
                if (k in wanted && v.isNotEmpty()) { out.putIfAbsent(k, v); continue }
            }
            // 2) A bare label whose value is the next node ("Name:" / "RRN" / "Order ID:").
            if (t.endsWith(":") || t.equals("RRN", true)) {
                val k = key(t)
                val v = texts.getOrNull(i + 1)?.trim().orEmpty()
                if (k in wanted && v.isNotEmpty() && !v.endsWith(":")) { out.putIfAbsent(k, v); continue }
            }
            // 3) Label and value fused around the amount ("Payment Amount₹ 1").
            val cur = t.indexOfFirst { it == '₹' }
            if (cur > 0) {
                val k = key(t.substring(0, cur))
                val v = t.substring(cur).trim()
                if (k in wanted && v.isNotEmpty()) { out.putIfAbsent(k, v); continue }
            }
            // 4) Sentence forms that carry their own label.
            if (t.startsWith("Paid at", true)) out.putIfAbsent("paid_at", t.removePrefix("Paid at").trim().trimStart(','))
            if (t.startsWith("Paid Using", true)) out.putIfAbsent("paid_using", t.removePrefix("Paid Using").trim())
        }
        return out
    }

    private fun launchReader(
        masked: String, amount: String, payer: String, upiId: String, paidAt: String, detailsJson: String
    ) {
        val i = Intent(this, ClipReaderActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
            putExtra("masked", masked)
            putExtra("amount", amount)
            putExtra("payer", payer)
            putExtra("upiId", upiId)
            putExtra("paidAt", paidAt)
            // The detail block is read HERE, while the payment's screen is still up: the reader
            // activity comes to the foreground on top of it and can no longer see it.
            putExtra("details", detailsJson)
        }
        runCatching { startActivity(i) }.onFailure {
            Log.w(TAG, "reader launch failed: ${it.message}")
            noteCaptureFail("clipboard reader could not start")
            onPaytmCaptureDone(applicationContext)
        }
    }

    private fun flatten(node: AccessibilityNodeInfo?, out: MutableList<Pair<String, AccessibilityNodeInfo>>) {
        if (node == null) return
        node.text?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it to node) }
        for (i in 0 until node.childCount) flatten(node.getChild(i), out)
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }
}
