package shop.glhouse.agent

import android.content.ComponentName
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import rikka.shizuku.Shizuku

// Shell-level command / tap injection via Shizuku. An AccessibilityService gesture is a
// "synthetic" touch that Paytm rejects; a tap issued at shell UID is injected at the
// input-driver level, so Paytm treats it as a real finger tap.
//
// Mechanism: a bound Shizuku USER SERVICE (IUserService, running in a shell-UID process).
// This replaces the old Shizuku.newProcess reflection call, which is a restricted API that
// fails silently on current Shizuku builds — the likely reason shell-taps "did nothing"
// despite Shizuku being granted. newProcess is kept only as a last-ditch fallback while the
// user service finishes binding.
object ShizukuTap {
    const val REQ_CODE = 4711

    @Volatile private var svc: IUserService? = null
    @Volatile private var binding = false

    private val userServiceArgs by lazy {
        Shizuku.UserServiceArgs(ComponentName(BuildConfig.APPLICATION_ID, ShizukuUserService::class.java.name))
            .daemon(false)                 // die with the app; no lingering shell process
            .processNameSuffix("shell")    // process shows as <pkg>:shell
            .debuggable(false)
            .version(BuildConfig.VERSION_CODE)
    }

    private val conn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            binding = false
            svc = if (binder != null && binder.pingBinder()) IUserService.Stub.asInterface(binder) else null
        }
        override fun onServiceDisconnected(name: ComponentName?) { svc = null; binding = false }
    }

    // Shizuku service is running and reachable.
    fun available(): Boolean = try { Shizuku.pingBinder() } catch (e: Throwable) { false }

    // We have permission to issue shell commands.
    fun granted(): Boolean = try {
        available() && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    } catch (e: Throwable) { false }

    // True once the shell-UID user service is bound and ready to execute (the state that
    // actually matters for hands-free tapping — "granted" alone isn't enough).
    fun ready(): Boolean = svc != null

    fun requestPermission() {
        try { if (available()) Shizuku.requestPermission(REQ_CODE) } catch (e: Throwable) {}
    }

    // Bind the shell-UID user service. Idempotent; safe to call repeatedly (e.g. on app
    // resume / capture start) — it primes svc so the first real tap doesn't fall back.
    fun bind() {
        if (svc != null || binding || !granted()) return
        binding = true
        try { Shizuku.bindUserService(userServiceArgs, conn) }
        catch (e: Throwable) { binding = false }
    }

    fun unbind() {
        try { if (svc != null) Shizuku.unbindUserService(userServiceArgs, conn, true) } catch (e: Throwable) {}
        svc = null; binding = false
    }

    // Inject `input tap x y` at shell UID. Returns true if a command channel handled it.
    fun tap(x: Int, y: Int): Boolean = exec("input tap $x $y") != null

    // Run an arbitrary shell command at shell UID (e.g. `svc power stayon true`). Returns
    // true if it ran. No-op when Shizuku isn't granted.
    fun shell(cmd: String): Boolean = exec(cmd) != null

    // Execute at shell UID via the bound user service; primes binding and falls back to the
    // legacy newProcess path only until the service is up. Returns stdout (may be empty) on
    // success, null on failure.
    private fun exec(cmd: String): String? {
        if (!granted()) return null
        svc?.let {
            return try { it.execute(cmd) } catch (e: Throwable) { svc = null; null }
        }
        bind()                 // kick off binding for next time
        return legacyExec(cmd) // best-effort this once while the service comes up
    }

    // Deprecated Shizuku.newProcess, reached by reflection. Unreliable on recent Shizuku —
    // kept ONLY as a transient fallback before the user service binds.
    private fun legacyExec(cmd: String): String? = try {
        val m = Shizuku::class.java.getDeclaredMethod(
            "newProcess", Array<String>::class.java, Array<String>::class.java, String::class.java)
        m.isAccessible = true
        val proc = m.invoke(null, arrayOf("sh", "-c", cmd), null, null) as java.lang.Process
        if (proc.waitFor() == 0) "" else null
    } catch (e: Throwable) { null }
}
