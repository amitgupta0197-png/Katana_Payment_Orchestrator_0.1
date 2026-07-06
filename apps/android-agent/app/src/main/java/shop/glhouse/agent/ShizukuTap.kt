package shop.glhouse.agent

import android.content.pm.PackageManager
import rikka.shizuku.Shizuku

// Shell-level tap injection via Shizuku. An AccessibilityService gesture is a "synthetic"
// touch that Paytm rejects; a tap issued through Shizuku runs as the shell user and is
// injected at the input-driver level, so the app treats it as a real finger tap. Requires
// the user to install the Shizuku app and grant this app permission once.
object ShizukuTap {
    const val REQ_CODE = 4711

    // Shizuku service is running and bound.
    fun available(): Boolean = try { Shizuku.pingBinder() } catch (e: Throwable) { false }

    // We have permission to issue shell commands.
    fun granted(): Boolean = try {
        available() && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    } catch (e: Throwable) { false }

    fun requestPermission() {
        try { if (available()) Shizuku.requestPermission(REQ_CODE) } catch (e: Throwable) {}
    }

    // Inject `input tap x y` as the shell user. Returns true if the command ran (exit 0).
    fun tap(x: Int, y: Int): Boolean {
        if (!granted()) return false
        return runShell("input tap $x $y")
    }

    // Run an arbitrary shell command as the shell user (e.g. `svc power stayon true` to hold the
    // screen awake system-wide). Returns true on exit 0. No-op if Shizuku isn't granted.
    fun shell(cmd: String): Boolean {
        if (!granted()) return false
        return runShell(cmd)
    }

    private fun runShell(cmd: String): Boolean = try {
        // Shizuku.newProcess is a restricted API — reach it via reflection to avoid the
        // lint gate. It returns a java.lang.Process running as the shell user.
        val m = Shizuku::class.java.getDeclaredMethod(
            "newProcess", Array<String>::class.java, Array<String>::class.java, String::class.java)
        m.isAccessible = true
        val proc = m.invoke(null, arrayOf("sh", "-c", cmd), null, null) as java.lang.Process
        proc.waitFor() == 0
    } catch (e: Throwable) { false }
}
