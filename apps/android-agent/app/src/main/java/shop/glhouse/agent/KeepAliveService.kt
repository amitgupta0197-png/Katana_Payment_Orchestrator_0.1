package shop.glhouse.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

// Persistent foreground service. Its only job is to keep the app process alive so the
// TxnNotificationListener (a NotificationListenerService) is not killed by aggressive
// OEM battery management — the #1 reason payment-app push alerts (Paytm / PhonePe for
// Business, which carry no UTR over SMS) silently stop reaching the dashboard.
//
// A foreground service must show an ongoing notification; we use an IMPORTANCE_MIN
// channel so it stays collapsed and unobtrusive. Combined with the battery-optimization
// exemption (MainActivity), this keeps capture alive across Doze.
class KeepAliveService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, n)
        }
        CommandPoller.start(applicationContext)   // poll for on-demand "Get RRN" requests
        return START_STICKY   // ask the OS to restart us if it kills the process
    }

    override fun onDestroy() {
        CommandPoller.stop()
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(NotificationManager::class.java)
            if (mgr.getNotificationChannel(CHANNEL) == null) {
                val ch = NotificationChannel(CHANNEL, "Agent status", NotificationManager.IMPORTANCE_MIN)
                ch.setShowBadge(false)
                mgr.createNotificationChannel(ch)
            }
        }
        return NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("Katana agent active")
            .setContentText("Watching for payment credits")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        private const val CHANNEL = "katana_agent_keepalive"
        private const val NOTIF_ID = 4711

        // Best-effort start. Background FGS starts are restricted on Android 12+, so
        // never let a denied start crash the caller (listener/boot/app-resume contexts).
        fun start(ctx: Context) {
            if (!Prefs.enabled(ctx)) return
            val i = Intent(ctx, KeepAliveService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
                else ctx.startService(i)
            } catch (e: Exception) { /* background-start not allowed right now; retried on next app open */ }
        }

        fun stop(ctx: Context) {
            try { ctx.stopService(Intent(ctx, KeepAliveService::class.java)) } catch (e: Exception) {}
        }
    }
}
