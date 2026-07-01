package shop.glhouse.agent

import android.content.Context

// Durable retry queue: if a captured alert can't be uploaded (no network, server
// down), its JSON body is persisted here and retried later (on the next capture, app
// open, or the periodic worker) so a real credit is never silently lost.
object OutboxStore {
    private const val PREF = "agent_outbox"
    private const val KEY = "items"
    private const val SEP = "\n--ITEM--\n"
    private const val MAX = 200

    @Synchronized
    fun enqueue(ctx: Context, body: String) {
        val sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        val cur = sp.getString(KEY, "") ?: ""
        val items = (cur.split(SEP).filter { it.isNotBlank() } + body).takeLast(MAX)
        sp.edit().putString(KEY, items.joinToString(SEP)).apply()
    }

    // Returns the queued bodies and clears the queue. Callers re-enqueue any that
    // still fail.
    @Synchronized
    fun drain(ctx: Context): List<String> {
        val sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        val items = (sp.getString(KEY, "") ?: "").split(SEP).filter { it.isNotBlank() }
        sp.edit().remove(KEY).apply()
        return items
    }

    @Synchronized
    fun size(ctx: Context): Int =
        (ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY, "") ?: "")
            .split(SEP).count { it.isNotBlank() }
}
