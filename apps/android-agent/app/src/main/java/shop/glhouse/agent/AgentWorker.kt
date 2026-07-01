package shop.glhouse.agent

import android.content.Context
import androidx.core.app.NotificationManagerCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

// Periodic background job: sends a heartbeat (with reported permission state) and
// flushes any queued alerts. Survives reboots and Doze (WorkManager reschedules), so
// the device stays "online" on the dashboard and no queued credit is left behind.
class AgentWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val ctx = applicationContext
        if (!Prefs.enabled(ctx)) return Result.success()
        val notifAccess = NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)
        runCatching { AlertUploader.heartbeatSync(ctx, notifAccess) }
        runCatching { AlertUploader.flushOutbox(ctx) }
        return Result.success()
    }

    companion object {
        private const val NAME = "katana-agent-sync"
        // 15 min is WorkManager's minimum periodic interval. Capture itself is
        // event-driven (real-time); this only drives heartbeat + retry.
        fun schedule(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<AgentWorker>(15, TimeUnit.MINUTES).build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.UPDATE, req)
        }
    }
}
