package shop.glhouse.agent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// Re-arm the periodic sync worker after a reboot (WorkManager usually persists, this
// is belt-and-braces). SMS capture and the notification listener resume automatically.
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            AgentWorker.schedule(context)
            KeepAliveService.start(context)   // re-arm the keep-alive after reboot
        }
    }
}
