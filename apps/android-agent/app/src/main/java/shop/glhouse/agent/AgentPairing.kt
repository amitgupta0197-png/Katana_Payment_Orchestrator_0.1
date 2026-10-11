package shop.glhouse.agent

import android.content.Context
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * PAIR THIS PHONE WITH A BANKER (v3.23). Staff make a one-time code on the banker page (a QR that
 * opens https://katanapay.co/pair/<code>, or the 8 letters typed here). The server answers with
 * everything the phone needs: the banker code, the server address, the payment app to read and,
 * for BharatPe, the MID's API key + secret — so nobody types a code or pastes a secret by hand.
 * Typing and pasting is where setups went wrong (a 15-character "secret" that was a PID, 2026-10-11).
 */
object AgentPairing {
    private val client = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()
    private val CODE_RX = Regex("^[A-HJKMNP-Z2-9]{8}$")

    fun normalise(input: String): String? = input.uppercase().replace(Regex("[\\s-]"), "").takeIf { CODE_RX.matches(it) }

    /** The code in a pairing link (https://host/pair/ABCD2345), with the server it came from. */
    fun fromLink(uri: android.net.Uri?): Pair<String, String>? {
        if (uri == null || uri.scheme != "https") return null
        val seg = uri.pathSegments
        if (seg.size != 2 || seg[0] != "pair") return null
        val code = normalise(seg[1]) ?: return null
        return "https://${uri.host}" to code
    }

    /** Redeem [code] at [base]; [done] gets a sentence for the person, and whether it worked. */
    fun pair(ctx: Context, base: String, code: String, done: (Boolean, String) -> Unit) {
        val body = JSONObject().apply {
            put("code", code); put("device_id", Prefs.deviceId(ctx)); put("install_id", Prefs.installId(ctx))
        }.toString()
        val req = Request.Builder().url(base.trimEnd('/') + "/api/v1/agent/pair")
            .post(body.toRequestBody("application/json".toMediaType())).build()
        client.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = done(false, "Can't reach Katana — check the phone's internet and try again")
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val d = runCatching { JSONObject(it.body?.string().orEmpty()) }.getOrDefault(JSONObject())
                    if (!it.isSuccessful) { done(false, d.optString("error").ifBlank { "Pairing failed (HTTP ${it.code})" }); return }
                    val merchant = d.optString("merchant_code")
                    if (merchant.isBlank()) { done(false, "Pairing failed: no banker in the answer"); return }
                    val server = d.optString("base_url").ifBlank { base }
                    Prefs.save(ctx, server, Prefs.deviceId(ctx), merchant, true)
                    val app = d.optString("capture_app").takeIf { a -> a.isNotBlank() && a != "null" }
                    if (app != null) Prefs.setCaptureAppExclusive(ctx, app)
                    var bp = ""
                    d.optJSONObject("bharatpe")?.let { b ->
                        val err = BharatpeUploader.save(ctx, b.optString("api_key"), b.optString("secret"))
                        bp = if (err == null) " · BharatPe ${if (b.optString("env") == "PROD") "live" else "test"} key saved" else " · BharatPe key not saved: $err"
                    }
                    AlertStore.log(ctx, "🔗 paired with $merchant${app?.let { a -> " · reading $a" } ?: ""}$bp")
                    KeepAliveService.start(ctx)
                    AlertUploader.heartbeat(ctx, true)
                    done(true, "Paired with ${d.optString("merchant_name").ifBlank { merchant }} ($merchant)${app?.let { a -> " · reading ${a.lowercase()}" } ?: ""}$bp")
                }
            }
        })
    }
}
