package shop.glhouse.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
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
    private var sweepPos = 0
    private var lastOpenResult = R_UNKNOWN
    private var autoNavigating = false      // we auto-opened the current detail
    private var backScheduled = false
    private var detailReached = false       // the auto-opened detail actually appeared
    private var openGen = 0                  // invalidates stale watchdog timers
    private var openRetries = 0
    private var backAttempts = 0            // how many BACKs we've pressed this return
    private var waitChecks = 0              // transitional re-checks while returning

    companion object {
        private const val MAX_ATTEMPTS = 4
        private const val COPY_SETTLE_MS = 450L
        private const val BUSY_MS = 4500L
        private const val COPY_X_FRAC = 0.855f
        private const val COPY_BAND_FRAC = 0.06f
        // Auto mode timings.
        private const val AUTO_DETAIL_BACK_MS = 2600L // return to list this long after opening a detail
        // Result of the last auto-opened detail (new = captured, old = boundary).
        private const val R_UNKNOWN = 0
        private const val R_NEW = 1
        private const val R_OLD = 2

        // Set by CommandPoller when the dashboard raises a "Get RRN" request: forces the
        // next payments-list pass to re-sweep the visible rows (retrying any whose RRN we
        // don't yet have) instead of idling until a new payment arrives. Cleared on use.
        @Volatile private var forceResweep = false
        fun requestResweep() { forceResweep = true }
    }

    private fun autoModeEnabled(): Boolean = Prefs.autoCapture(this)

    override fun onServiceConnected() {
        super.onServiceConnected()
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
            "com.paytm.business" -> if (Prefs.captureAppOn(this, Prefs.APP_PAYTM)) handlePaytm(root)
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
                if (fresh) Log.d(TAG, "airtel: RRN $rrn amount=$amount payer=$payer")
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
    // Google's internal ref — ignored). Passive read: capture whenever a detail screen is
    // visible — no tap/copy needed. GPay's LIST rows don't carry the RRN, so the merchant
    // (or a future auto-drive) opens each payment; on the detail screen this just reads it.
    private val gpayAmount = Regex("₹\\s?[0-9][0-9,]*(?:\\.[0-9]{1,2})?")

    private fun handleGpay(root: AccessibilityNodeInfo) {
        if (!Prefs.enabled(this)) return
        val descs = ArrayList<String>()
        collectDescs(root, descs)
        // Join everything so we can index label→value across nodes whether GPay bundles the
        // block into one description or splits it. Only proceed on a detail screen.
        val lines = descs.joinToString("\n").split('\n', '\r').map { it.trim() }.filter { it.isNotEmpty() }
        val idIdx = lines.indexOfFirst { it.equals("UPI Transaction ID", true) }
        if (idIdx < 0 || idIdx + 1 >= lines.size) return   // not a transaction detail screen
        val rrn = lines[idIdx + 1].filter { it.isDigit() }
        if (!Regex("\\d{12}").matches(rrn)) return

        // Amount the customer PAID (matches the order); fall back to "Amount you get" or a
        // "₹X credited" summary line.
        fun amtAfter(label: String): String? {
            val i = lines.indexOfFirst { it.equals(label, true) }
            if (i < 0 || i + 1 >= lines.size) return null
            return gpayAmount.find(lines[i + 1])?.value
        }
        val amount = amtAfter("Customer paid") ?: amtAfter("Amount you get")
            ?: lines.firstOrNull { it.contains("credited", true) }?.let { gpayAmount.find(it)?.value } ?: ""

        // Payer: "Received from Shubham K".
        val payer = lines.firstOrNull { it.startsWith("Received from", true) }
            ?.replaceFirst(Regex("(?i)^received from"), "")?.trim() ?: ""

        val fresh = RrnStore.record(RrnRecord(
            rrn = rrn, capturedAt = System.currentTimeMillis(),
            amount = amount, payer = payer, upiId = "",
            paidAt = "", maskedRef = rrn, bank = "GPAY",
        ))
        if (fresh) Log.d(TAG, "gpay: RRN $rrn amount=$amount payer=$payer")
    }

    // Flutter semantics live in contentDescription; also fold in any real text nodes.
    private fun collectDescs(node: AccessibilityNodeInfo?, out: MutableList<String>) {
        if (node == null) return
        node.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it) }
        node.text?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it) }
        for (i in 0 until node.childCount) collectDescs(node.getChild(i), out)
    }

    // ---------------------------------------------------------------- detail

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

        val now = System.currentTimeMillis()
        if (now < detailBusyUntil) return

        val rrnLabelIdx = texts.indexOfFirst { it.equals("RRN", true) }
        if (rrnLabelIdx < 0) return

        var masked: String? = null
        var copyNode: AccessibilityNodeInfo? = null
        for (i in rrnLabelIdx + 1 until ordered.size) {
            val t = ordered[i].first
            if (masked == null && maskedRrn.containsMatchIn(t)) masked = maskedRrn.find(t)!!.value
            if (masked != null && t.trim().equals("Copy", true)) { copyNode = ordered[i].second; break }
        }
        if (masked == null || copyNode == null) return
        // Tell the auto-sweep whether this row is new or an already-captured
        // boundary (this is how the sweep knows where "new" ends).
        if (autoNavigating) lastOpenResult = if (RrnStore.isMaskedCaptured(masked)) R_OLD else R_NEW
        if (RrnStore.isMaskedCaptured(masked)) return
        val n = attempts.getOrDefault(masked, 0)
        if (n >= MAX_ATTEMPTS) return

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            Log.w(TAG, "screenshot capture needs Android 11+; cannot auto-tap on this device")
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
        Log.d(TAG, "RRN row: masked=$masked amt=$amount payer=$payer attempt=${n + 1} -> scroll+screenshot")
        swipeUp { swipeUp { captureViaScreenshot(masked, amount, payer, upiId, paidAt, copyX, bandX0, bandX1) } }
    }

    // ------------------------------------------------------------------ list

    private fun handleList(ordered: List<Pair<String, AccessibilityNodeInfo>>) {
        val count = parseCount(ordered.map { it.first })
        if (count < 0) return // not the payments list (no "N Payments" header)
        if (sweeping) return  // a sweep is already running; the pump drives it

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
        sweepPos = 0
        openNext()
    }

    private fun openNext() {
        if (!sweeping) return
        val root = rootInActiveWindow
        val ordered = ArrayList<Pair<String, AccessibilityNodeInfo>>()
        if (root != null) flatten(root, ordered)
        val count = parseCount(ordered.map { it.first })
        if (count < 0) { // list not settled yet (detail still closing) -> retry
            if (openRetries++ < 8) main.postDelayed({ openNext() }, 500) else sweeping = false
            return
        }
        openRetries = 0
        val rows = findRows(ordered)
        if (sweepPos >= rows.size) {
            sweeping = false; handledCount = count
            Log.d(TAG, "auto: swept all visible rows -> waiting for new payments")
            return
        }
        val (x, y) = rows[sweepPos]
        autoNavigating = true
        backScheduled = false
        detailReached = false
        lastOpenResult = R_UNKNOWN
        val gen = ++openGen
        Log.d(TAG, "auto: opening row #$sweepPos (y=$y)")
        tap(x, y)
        // Watchdog: if the tap never opened a detail, skip this row and continue.
        main.postDelayed({
            if (gen == openGen && sweeping && !detailReached) {
                Log.w(TAG, "auto: row #$sweepPos did not open; skipping")
                sweepPos++; openNext()
            }
        }, 4500)
    }

    private fun onReturned() {
        if (!sweeping) return
        if (lastOpenResult == R_OLD) {
            sweeping = false
            Log.d(TAG, "auto: reached already-captured txn -> sweep complete")
            return
        }
        sweepPos++
        openNext()
    }

    /** Paytm's "… from N Payments" total, or -1 if this isn't the payments list. */
    private fun parseCount(texts: List<String>): Int {
        for (t in texts) countRx.find(t)?.let {
            return it.groupValues[1].replace(",", "").toIntOrNull() ?: -1
        }
        return -1
    }

    /** Tap points (screen-centre X, row Y) for each transaction row, top to bottom. */
    private fun findRows(ordered: List<Pair<String, AccessibilityNodeInfo>>): List<Pair<Float, Float>> {
        val sw = resources.displayMetrics.widthPixels
        val ys = ArrayList<Float>()
        for ((t, n) in ordered) {
            if (!timeRx.containsMatchIn(t)) continue
            val r = Rect().also { n.getBoundsInScreen(it) }
            if (r.width() <= 0 || r.height() <= 0) continue
            ys.add(r.exactCenterY())
        }
        return ys.distinctBy { (it / 10f).toInt() }.sorted().map { sw / 2f to it }
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
            (pkg == "com.paytm.business" || pkg == packageName) && waitChecks < 6 -> {
                waitChecks++; main.postDelayed({ verifyOnList() }, 500) // reader/transition — wait it out
            }
            else -> {
                Log.w(TAG, "auto: could not return to payments list; pausing sweep")
                sweeping = false
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

    private fun captureViaScreenshot(
        masked: String, amount: String, payer: String, upiId: String, paidAt: String,
        copyX: Float, bandX0: Int, bandX1: Int
    ) {
      runCatching {
        takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
            override fun onSuccess(result: ScreenshotResult) {
                val bmp = runCatching {
                    Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
                        ?.copy(Bitmap.Config.ARGB_8888, false)
                }.getOrNull()
                result.hardwareBuffer.close()
                if (bmp == null) { Log.w(TAG, "screenshot bitmap null"); return }
                val y = findCopyRowY(bmp, bandX0, bandX1)
                bmp.recycle()
                if (y <= 0f) { Log.w(TAG, "Copy link not found in screenshot"); return }
                Log.d(TAG, "found Copy at ($copyX,$y) -> tapping")
                tapAndRead(copyX, y, masked, amount, payer, upiId, paidAt)
            }
            override fun onFailure(errorCode: Int) {
                Log.w(TAG, "takeScreenshot failed: $errorCode")
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
        x: Float, y: Float, masked: String, amount: String, payer: String, upiId: String, paidAt: String
    ) {
        val path = Path().apply { moveTo(x, y) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 60))
            .build()
        val fired = dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(d: GestureDescription?) {
                main.postDelayed({ launchReader(masked, amount, payer, upiId, paidAt) }, COPY_SETTLE_MS)
            }
            override fun onCancelled(d: GestureDescription?) { Log.w(TAG, "tap cancelled") }
        }, null)
        if (!fired) Log.w(TAG, "dispatchGesture returned false")
    }

    private fun launchReader(masked: String, amount: String, payer: String, upiId: String, paidAt: String) {
        val i = Intent(this, ClipReaderActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
            putExtra("masked", masked)
            putExtra("amount", amount)
            putExtra("payer", payer)
            putExtra("upiId", upiId)
            putExtra("paidAt", paidAt)
        }
        runCatching { startActivity(i) }.onFailure { Log.w(TAG, "reader launch failed: ${it.message}") }
    }

    private fun flatten(node: AccessibilityNodeInfo?, out: MutableList<Pair<String, AccessibilityNodeInfo>>) {
        if (node == null) return
        node.text?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it to node) }
        for (i in 0 until node.childCount) flatten(node.getChild(i), out)
    }

    override fun onInterrupt() {}
}
