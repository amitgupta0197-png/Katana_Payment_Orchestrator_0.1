package shop.glhouse.agent

import android.content.Context

// Recent-alert log (for the UI) + a short-window de-dup set so the SAME credit seen
// via both SMS and a notification is only forwarded once.
object AlertStore {
    private const val PREF = "agent_store"
    private const val KEY_LOG = "log"
    private const val KEY_SEEN = "seen"
    private const val DEDUP_WINDOW_MS = 3 * 60 * 1000L
    private const val MAX_LOG = 50

    // Returns true if `key` was already seen within the dedup window. Records it
    // (and prunes expired keys) as a side effect.
    @Synchronized
    fun seenRecently(ctx: Context, key: String): Boolean {
        val sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val kept = StringBuilder()
        var found = false
        for (line in (sp.getString(KEY_SEEN, "") ?: "").split("\n")) {
            if (line.isBlank()) continue
            val idx = line.lastIndexOf('|')
            if (idx <= 0) continue
            val k = line.substring(0, idx)
            val ts = line.substring(idx + 1).toLongOrNull() ?: 0L
            if (now - ts > DEDUP_WINDOW_MS) continue
            kept.append(line).append('\n')
            if (k == key) found = true
        }
        if (!found) kept.append(key).append('|').append(now).append('\n')
        sp.edit().putString(KEY_SEEN, kept.toString()).apply()
        return found
    }

    @Synchronized
    fun log(ctx: Context, line: String) {
        android.util.Log.d("KatanaAgent", line)   // mirror to logcat for diagnostics
        val sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        val cur = sp.getString(KEY_LOG, "") ?: ""
        val lines = (listOf(line) + cur.split("\n")).filter { it.isNotBlank() }.take(MAX_LOG)
        sp.edit().putString(KEY_LOG, lines.joinToString("\n")).apply()
    }

    fun recent(ctx: Context): String =
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY_LOG, "") ?: ""
}
