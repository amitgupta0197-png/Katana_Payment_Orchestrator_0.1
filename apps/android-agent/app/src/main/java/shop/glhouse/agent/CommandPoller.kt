package shop.glhouse.agent

import android.content.Context
import android.os.Handler
import android.os.HandlerThread

/**
 * Polls the orchestrator for on-demand RRN capture requests (raised by the dashboard
 * "Get RRN" button) and fulfils them automatically — no merchant tap.
 *
 * When one or more requests are open for this merchant, it asks the accessibility
 * engine to re-sweep the Paytm payments list (which the dedicated capture phone keeps
 * open): the sweep re-reads the visible rows, captures any RRN it doesn't yet have, and
 * uploads it. The server then backfills the matching credit and closes the request, so
 * it stops coming back on the next poll. Driven by KeepAliveService (the always-alive
 * foreground service).
 *
 * Capture still needs Paytm Business open on the payments list — the same constraint as
 * auto-capture; the engine can only read what's on screen.
 */
object CommandPoller {
    private const val POLL_MS = 15_000L

    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var appCtx: Context? = null

    private val tick = object : Runnable {
        override fun run() {
            val ctx = appCtx ?: return
            try { if (Prefs.enabled(ctx)) poll(ctx) } catch (e: Exception) { /* keep looping */ }
            handler?.postDelayed(this, POLL_MS)
        }
    }

    fun start(ctx: Context) {
        if (thread != null) return
        appCtx = ctx.applicationContext
        thread = HandlerThread("katana-cmd-poll").also { it.start() }
        handler = Handler(thread!!.looper).also { it.postDelayed(tick, 5_000L) }
    }

    fun stop() {
        handler?.removeCallbacksAndMessages(null)
        thread?.quitSafely()
        thread = null; handler = null
    }

    private fun poll(ctx: Context) {
        val cmds = AlertUploader.fetchCommands(ctx)
        if (cmds.isEmpty()) return
        AlertStore.log(ctx, "${nowTag()} 🔔 ${cmds.size} RRN request(s) — re-sweeping Paytm")
        // Automatic fulfilment: drive the accessibility sweep to re-read the payments list.
        // Only meaningful with auto-capture on (that's what runs the sweep).
        if (Prefs.autoCapture(ctx)) RrnAccessibilityService.requestResweep()
    }

    private fun nowTag(): String =
        java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())
}
