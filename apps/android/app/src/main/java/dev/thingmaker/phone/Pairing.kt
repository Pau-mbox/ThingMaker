package dev.thingmaker.phone

import android.content.Context
import org.json.JSONObject

/**
 * The Mac this phone is paired with: where to find it on the tailnet and the
 * token it issued. Kept in the app's private storage, which only this app
 * can read.
 */
data class Pairing(val hosts: List<String>, val port: Int, val token: String, val macName: String, val deviceId: String) {
    fun baseUrls(): List<String> = hosts.map { "http://$it:$port" }

    companion object {
        private const val PREFS = "pairing"

        fun load(context: Context): Pairing? {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val token = prefs.getString("token", null) ?: return null
            val hosts = prefs.getString("hosts", "")!!.split(',').filter { it.isNotBlank() }
            if (hosts.isEmpty()) return null
            return Pairing(hosts, prefs.getInt("port", 47321), token, prefs.getString("name", "Mac")!!, prefs.getString("device", "")!!)
        }

        fun save(context: Context, pairing: Pairing) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("hosts", pairing.hosts.joinToString(","))
                .putInt("port", pairing.port)
                .putString("token", pairing.token)
                .putString("name", pairing.macName)
                .putString("device", pairing.deviceId)
                .apply()
        }

        fun clear(context: Context) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        }
    }
}

/** What the Mac's QR code carries: `thingmaker-pair:{"v":1,"name":…,"hosts":[…],"port":…,"code":…}`. */
data class PairingOffer(val name: String, val hosts: List<String>, val port: Int, val code: String) {
    companion object {
        fun parse(text: String): PairingOffer? = runCatching {
            val json = JSONObject(text.trim().removePrefix("thingmaker-pair:"))
            val hosts = json.getJSONArray("hosts")
            PairingOffer(
                name = json.optString("name", "Mac"),
                hosts = (0 until hosts.length()).map { hosts.getString(it) },
                port = json.optInt("port", 47321),
                code = json.getString("code"),
            )
        }.getOrNull()
    }
}
