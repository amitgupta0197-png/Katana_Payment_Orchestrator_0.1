package shop.glhouse.agent

import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.WindowManager

/**
 * Keeps the device screen on for a dedicated capture phone.
 *
 * On-device RRN capture can only read the Paytm screen while the display is on, so a
 * phone left as the capture device must not sleep. We hold the screen on with an
 * invisible 1x1 overlay window carrying FLAG_KEEP_SCREEN_ON — because it's a system
 * overlay (TYPE_APPLICATION_OVERLAY) it keeps the screen awake globally, even while
 * Paytm Business is in the foreground. This reuses the "Display over other apps"
 * permission the RRN capture already needs; no wake-lock or WRITE_SETTINGS required.
 *
 * Toggled by [Prefs.keepAwake]. Held by the app process (kept alive by KeepAliveService),
 * so it survives the settings screen being closed.
 */
object ScreenAwake {
    private const val TAG = "ScreenAwake"
    private var view: View? = null

    /** Add or remove the keep-awake overlay to match the current preference. */
    fun apply(ctx: Context) {
        if (Prefs.keepAwake(ctx)) enable(ctx.applicationContext) else disable(ctx.applicationContext)
    }

    private fun enable(ctx: Context) {
        if (view != null) return
        if (!Settings.canDrawOverlays(ctx)) {
            Log.w(TAG, "keep-awake needs 'Display over other apps' permission")
            return
        }
        val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
        val lp = WindowManager.LayoutParams(
            1, 1, type,
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT,
        )
        val v = View(ctx)
        try {
            wm.addView(v, lp)
            view = v
            Log.d(TAG, "keep-awake overlay added")
        } catch (e: Exception) { Log.w(TAG, "addView failed: ${e.message}") }
    }

    private fun disable(ctx: Context) {
        val v = view ?: return
        val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        try { wm.removeView(v) } catch (e: Exception) { /* already gone */ }
        view = null
        Log.d(TAG, "keep-awake overlay removed")
    }
}
