package shop.glhouse.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

// Polls the orchestrator for on-demand RRN capture requests (raised by the dashboard
// "Get RRN" button) and surfaces each as a high-priority, tappable notification that
// opens Paytm Business so the merchant taps "Copy" on the named payment. On a Shizuku
// device with Auto-capture on, it also brings Paytm forward so the accessibility sweep
// can capture hands-free. Driven by KeepAliveService (the always-alive foreground svc).
object CommandPoller {
    private const val CHANNEL = "katana_capture_requests"
    private const val POLL_MS = 15_000L
    private const val PAYTM_PKG = "com.paytm.business"

    private var thread: HandlerThread? = null
    private var handler: Handler? = null

    private val tick = object : Runnable {
        override fun run() {
            val ctx = appCtx ?: return
            try { if (Prefs.enabled(ctx)) poll(ctx) } catch (e: Exception) { /* keep looping */ }
            handler?.postDelayed(this, POLL_MS)
        }
    }
    private var appCtx: Context? = null

    fun start(ctx: Context) {
        if (thread != null) return
        appCtx = ctx.applicationContext
        thread = HandlerThread("katana-cmd-poll").also { it.start() }
        handler = Handler(thread!!.looper).also { it.postDelayed(tick, 3_000L) }
    }

    fun stop() {
        handler?.removeCallbacksAndMessages(null)
        thread?.quitSafely()
        thread = null; handler = null
    }

    private fun poll(ctx: Context) {
        val cmds = AlertUploader.fetchCommands(ctx)
        for (c in cmds) {
            if (Prefs.commandSeen(ctx, c.id)) continue
            Prefs.markCommandSeen(ctx, c.id)
            notifyCapture(ctx, c)
            AlertStore.log(ctx, "${nowTag()} 🔔 capture request ₹${c.amount} ${c.payerVpa ?: ""}")
            // Shizuku + Auto-capture → bring Paytm forward so the sweep can grab it hands-free.
            if (ShizukuTap.granted() && Prefs.autoOpen(ctx)) openPaytm(ctx)
        }
    }

    private fun notifyCapture(ctx: Context, c: AlertUploader.CaptureCmd) {
        ensureChannel(ctx)
        val amt = if (c.amount > 0) "₹${trimAmount(c.amount)}" else "a payment"
        val who = c.payerVpa?.let { " from $it" } ?: ""
        val open = ctx.packageManager.getLaunchIntentForPackage(PAYTM_PKG)
            ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = open?.let {
            PendingIntent.getActivity(ctx, c.id.hashCode(), it,
                PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0))
        }
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setContentTitle("Add RRN — $amt")
            .setContentText("Open the$who payment in Paytm and tap ‘Copy’ next to RRN")
            .setStyle(NotificationCompat.BigTextStyle().bigText("Open the$who payment in Paytm Business and tap ‘Copy’ next to RRN — Katana captures it automatically."))
            .setSmallIcon(R.mipmap.ic_launcher)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .apply { pi?.let { setContentIntent(it) } }
            .build()
        runCatching { NotificationManagerCompat.from(ctx).notify(c.id.hashCode(), n) }
    }

    private fun openPaytm(ctx: Context) {
        runCatching {
            ctx.packageManager.getLaunchIntentForPackage(PAYTM_PKG)
                ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { ctx.startActivity(it) }
        }
    }

    private fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = ctx.getSystemService(NotificationManager::class.java)
        if (mgr.getNotificationChannel(CHANNEL) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL, "RRN capture requests", NotificationManager.IMPORTANCE_HIGH)
                    .apply { description = "Prompts to tap Copy for a specific payment" })
        }
    }

    private fun trimAmount(a: Double): String =
        if (a == a.toLong().toDouble()) a.toLong().toString() else a.toString()

    private fun nowTag(): String =
        java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())
}
