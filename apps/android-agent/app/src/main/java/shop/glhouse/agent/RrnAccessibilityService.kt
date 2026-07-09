package shop.glhouse.agent

import android.accessibilityservice.AccessibilityService
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
        Log.d(TAG, "service connected (sdk=${Build.VERSION.SDK_INT})")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val root = rootInActiveWindow ?: return
        if (root.packageName?.toString() != "com.paytm.business") return

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
