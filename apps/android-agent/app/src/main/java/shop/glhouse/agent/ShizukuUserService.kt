package shop.glhouse.agent

import kotlin.system.exitProcess

// The Shizuku user service. Shizuku launches this class in a separate process running as the
// SHELL user (uid 2000, the same uid `adb shell` has) and loads our APK into it. Anything run
// from here therefore executes at shell privilege — crucially, `input tap x y` is injected at
// the input-driver level, which Paytm accepts as a genuine touch (it silently drops the
// synthetic gestures an AccessibilityService can dispatch).
//
// Shizuku requires a public no-arg (or single-Context) constructor and a destroy() that ends
// the process. Bound from ShizukuTap via Shizuku.bindUserService.
class ShizukuUserService : IUserService.Stub {

    // Shizuku instantiates this reflectively; keep the no-arg constructor.
    @Suppress("unused")
    constructor()

    override fun destroy() {
        exitProcess(0)
    }

    override fun execute(command: String): String {
        return try {
            val p = ProcessBuilder("sh", "-c", command).redirectErrorStream(true).start()
            val out = p.inputStream.bufferedReader().readText()
            p.waitFor()
            out
        } catch (e: Exception) {
            "ERR:${e.message}"
        }
    }
}
