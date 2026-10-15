package dev.thingmaker.phone

import android.content.Context
import okhttp3.Request
import org.json.JSONObject

/**
 * The Mac this phone is paired with: its relay on Cloudflare, the Cloudflare
 * Access service token in front of it, and the token the Mac issued this
 * phone. Kept in the app's private storage, which only this app can read.
 */
data class Pairing(
    /** `https://thingmaker-relay.<account>.workers.dev`. */
    val url: String,
    val token: String,
    val macName: String,
    val deviceId: String,
    val accessId: String?,
    val accessSecret: String?,
) {
    /** The relay's WebSocket address for a path. */
    fun socketUrl(path: String): String = url.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + path

    /** Cloudflare Access lets a request through only with these. */
    fun accessHeaders(): Map<String, String> =
        if (accessId.isNullOrBlank() || accessSecret.isNullOrBlank()) emptyMap() else mapOf("CF-Access-Client-Id" to accessId, "CF-Access-Client-Secret" to accessSecret)

    fun authorize(builder: Request.Builder): Request.Builder = builder.apply { accessHeaders().forEach { (name, value) -> header(name, value) } }

    companion object {
        private const val PREFS = "pairing"

        fun load(context: Context): Pairing? {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            // A pairing from before the relay (it had addresses, not a URL)
            // cannot be used: the phone pairs again.
            val url = prefs.getString("url", null) ?: return null
            val token = prefs.getString("token", null) ?: return null
            return Pairing(url, token, prefs.getString("name", "Mac")!!, prefs.getString("device", "")!!, prefs.getString("accessId", null), prefs.getString("accessSecret", null))
        }

        fun save(context: Context, pairing: Pairing) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .clear()
                .putString("url", pairing.url)
                .putString("token", pairing.token)
                .putString("name", pairing.macName)
                .putString("device", pairing.deviceId)
                .putString("accessId", pairing.accessId)
                .putString("accessSecret", pairing.accessSecret)
                .apply()
        }

        fun clear(context: Context) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        }
    }
}

/**
 * What the Mac's QR code carries:
 * `thingmaker-pair:{"v":2,"name":…,"url":…,"code":…,"accessId":…,"accessSecret":…}`.
 */
data class PairingOffer(val name: String, val url: String, val code: String, val accessId: String?, val accessSecret: String?) {
    companion object {
        fun parse(text: String): PairingOffer? = runCatching {
            val json = JSONObject(text.trim().removePrefix("thingmaker-pair:"))
            val url = json.getString("url").trimEnd('/')
            PairingOffer(
                name = json.optString("name", "Mac"),
                url = url,
                code = json.getString("code"),
                accessId = json.optString("accessId").takeIf { it.isNotBlank() && it != "null" },
                accessSecret = json.optString("accessSecret").takeIf { it.isNotBlank() && it != "null" },
            )
        }.getOrNull()
    }
}
