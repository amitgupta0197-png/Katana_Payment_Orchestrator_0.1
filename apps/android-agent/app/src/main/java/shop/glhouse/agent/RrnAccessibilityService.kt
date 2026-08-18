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

    // ---- detail-capture state ----
    private val attempts = HashMap<String, Int>()
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
        private const val CAPTURE_SETTLE_MS = 900L
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
        var n: AccessibilityNodeInfo? = node
        var depth = 0
        while (n != null && depth < 6) {
            if (n.isClickable) { n.performAction(AccessibilityNodeInfo.ACTION_CLICK); return true }
            n = n.parent; depth++
        }
        val r = Rect().also { node.getBoundsInScreen(it) }
        if (r.width() > 0 && r.height() > 0) { tap(r.exactCenterX(), r.exactCenterY()); return true }
        return false
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

        var masked: String? = null
        var copyNode: AccessibilityNodeInfo? = null
        for (i in rrnLabelIdx + 1 until ordered.size) {
            val t = ordered[i].first
            if (masked == null && maskedRrn.containsMatchIn(t)) masked = maskedRrn.find(t)!!.value
            if (masked != null && t.trim().equals("Copy", true)) { copyNode = ordered[i].second; break }
        }
        if (masked == null || copyNode == null) {
            // The screen has an RRN label but not the shape we expect — usually a Paytm
            // layout change. Previously this returned silently and the capture request just
            // expired, telling nobody anything.
            noteCaptureFail(if (masked == null) "no masked RRN after label" else "no Copy node after RRN")
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
        val cRect = Rect().also { copyNode.getBoundsInScreen(it) }
        val copyX: Float
        val bandX0: Int
        val bandX1: Int
        if (cRect.width() > 0) {
            copyX = cRect.exactCenterX()
            val margin = (sw * 0.02f).toInt()
            bandX0 = cRect.left - margin
            bandX1 = cRect.right + margin
        } else {
            copyX = sw * COPY_X_FRAC
            bandX0 = (sw * (COPY_X_FRAC - COPY_BAND_FRAC)).toInt()
            bandX1 = (sw * (COPY_X_FRAC + COPY_BAND_FRAC)).toInt()
        }
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
        Log.d(TAG, "RRN row: masked=$masked amt=$amount payer=$payer fields=${detailsJson.length}b attempt=${n + 1} -> scroll+screenshot")
        swipeUp { swipeUp { captureViaScreenshot(masked, amount, payer, upiId, paidAt, detailsJson, copyX, bandX0, bandX1) } }
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
        sweptKeys.clear()
        sweepScrolls = 0
        oldStreak = 0
        openNext()
    }

    private fun openNext() {
        if (!sweeping) return
        val root = rootInActiveWindow
        val ordered = ArrayList<Pair<String, AccessibilityNodeInfo>>()
        if (root != null) flatten(root, ordered)
        val count = parseCount(ordered.map { it.first })
        if (count < 0) { // list not settled yet (detail still closing) -> retry
            if (openRetries++ < 8) main.postDelayed({ openNext() }, 500)
            else endSweep(handledCount, "list never settled")
            return
        }
        openRetries = 0
        val rows = findRowNodes(ordered)
        val next = rows.firstOrNull { it.first !in sweptKeys }
        if (next == null) {
            // Everything on screen has been visited. Scroll and keep going — the payments this
            // sweep exists to rescue are exactly the ones a burst pushed below the fold.
            if (sweepScrolls < MAX_SWEEP_SCROLLS) {
                sweepScrolls++
                Log.d(TAG, "auto: visible rows done -> scrolling for more ($sweepScrolls/$MAX_SWEEP_SCROLLS)")
                swipeUp { openNext() }
                return
            }
            endSweep(count, "reached the sweep depth limit")
            return
        }
        val (key, node) = next
        sweptKeys.add(key)
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
        if (lastOpenResult == R_OLD) {
            oldStreak++
            if (oldStreak >= STOP_AFTER_OLD) {
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
        val onList = parseCount(texts) >= 0
        val onDetail = texts.any { it.equals("RRN", true) }
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
        detailsJson: String, copyX: Float, bandX0: Int, bandX1: Int
    ) {
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
                    noteCaptureFail("screenshot unreadable"); onPaytmCaptureDone(applicationContext); return
                }
                val y = findCopyRowY(bmp, bandX0, bandX1)
                bmp.recycle()
                if (y <= 0f) {
                    Log.w(TAG, "Copy link not found in screenshot")
                    noteCaptureFail("no Copy link on screen"); onPaytmCaptureDone(applicationContext); return
                }
                Log.d(TAG, "found Copy at ($copyX,$y) -> tapping")
                tapAndRead(copyX, y, masked, amount, payer, upiId, paidAt, detailsJson)
            }
            override fun onFailure(errorCode: Int) {
                Log.w(TAG, "takeScreenshot failed: $errorCode")
                noteCaptureFail("screenshot failed ($errorCode)")
                onPaytmCaptureDone(applicationContext)
            }
        })
      }.onFailure { Log.w(TAG, "takeScreenshot threw: ${it.message}") }
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
