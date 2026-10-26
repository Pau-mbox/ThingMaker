package dev.thingmaker.remote

import android.app.Notification
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Keeps a line open to the computer while the app is closed, so the phone hears
 * when a Big Thing asks something, is blocked or is done, and when a
 * worker's job fails. No push service in between: the computer speaks to this
 * phone through its relay.
 */
class BridgeService : Service() {
    private val client = OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).connectTimeout(5, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).build()
    private val handler = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var pairing: Pairing? = null
    private var retry = 2_000L
    private var stopped = false
    /** What the ongoing notification says now; a second start keeps it. */
    private var shown: String? = null
    /** A job is told about once, however often it changes after failing. */
    private val toldJobs = mutableSetOf<String>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun attachBaseContext(newBase: Context) = super.attachBaseContext(AppSettings.localized(newBase))

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Notifier.channels(this)
        pairing = Pairing.load(this) ?: run {
            stopSelf()
            return START_NOT_STICKY
        }
        startForeground(ONGOING, ongoing(shown ?: getString(R.string.service_connecting, pairing!!.macName)), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        if (socket == null) open()
        return START_STICKY
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        stopped = true
        handler.removeCallbacksAndMessages(null)
        socket?.close(1000, "stopped")
        super.onDestroy()
    }

    private fun ongoing(text: String): Notification = Notification.Builder(this, Notifier.CONNECTION)
        .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
        .setContentTitle("ThingMaker")
        .setContentText(text)
        .setContentIntent(Notifier.open(this))
        .setOngoing(true)
        .build()

    private fun status(text: String) {
        shown = text
        getSystemService(NotificationManager::class.java).notify(ONGOING, ongoing(text))
    }

    private fun open() {
        val pairing = pairing ?: return
        val request = pairing.authorize(Request.Builder().url(pairing.socketUrl("/v1/ws"))).build()
        socket = client.newWebSocket(request, Listener(pairing))
    }

    private fun reconnect() {
        socket = null
        if (stopped) return
        handler.postDelayed({ open() }, retry)
        retry = (retry * 2).coerceAtMost(60_000L)
    }

    private inner class Listener(private val pairing: Pairing) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send(JSONObject(pairing.hello()).put("client", "thingmaker-remote-service").toString())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val frame = runCatching { JSONObject(text) }.getOrNull() ?: return
            when (frame.optString("t")) {
                "welcome" -> {
                    retry = 2_000L
                    status(getString(R.string.service_connected, pairing.macName))
                    // Reports made while there was no line, an update of this
                    // app included: it could only say so now.
                    val prefs = getSharedPreferences("install", MODE_PRIVATE)
                    prefs.getString("selfUpdate", null)?.let { id -> prefs.edit().putString("pending:$id", "installed").remove("selfUpdate").apply() }
                    for ((key, state) in prefs.all) {
                        if (!key.startsWith("pending:")) continue
                        webSocket.send(JSONObject().put("t", "install_status").put("id", key.removePrefix("pending:")).put("state", state.toString()).toString())
                        prefs.edit().remove(key).apply()
                    }
                }
                "install" -> {
                    val nearby = frame.optJSONObject("nearby")?.let { Nearby(it.optString("url"), it.optString("key"), it.optString("cert")) }?.takeIf { it.url.startsWith("https://") && it.key.isNotEmpty() && it.cert.length == 64 }
                    offered(Offer(frame.optString("id"), frame.optString("name"), frame.optLong("size"), frame.optString("sha256"), frame.optString("from", pairing.macName), nearby))
                }
                "denied" -> {
                    stopped = true
                    Notifier.attention(this@BridgeService, getString(R.string.revoked_title), getString(R.string.revoked_body, pairing.macName))
                    stopSelf()
                }
                "event" -> event(frame.optString("name"), frame.optJSONObject("payload"))
            }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            status(getString(R.string.service_waiting, pairing.macName))
            reconnect()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            status(getString(R.string.service_waiting, pairing.macName))
            reconnect()
        }
    }

    /** An app from the computer: straight to the install screen when the app is open, a notification when not. */
    private fun offered(offer: Offer) {
        if (offer.id.isEmpty()) return
        val open = offer.into(Intent(this, InstallActivity::class.java)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (App.foreground) {
            startActivity(open)
            return
        }
        Notifier.install(this, offer, open)
    }

    /** What reaches the phone while the app is closed. */
    private fun event(name: String, payload: JSONObject?) {
        if (payload == null || App.foreground) return
        when (name) {
            "thingmaker://bigthing" -> if (payload.optString("kind") == "notify") {
                val title = when (payload.optString("attention")) {
                    "needs_input" -> getString(R.string.bigthing_needs_you)
                    "blocked" -> getString(R.string.bigthing_blocked)
                    "done" -> getString(R.string.bigthing_done)
                    else -> getString(R.string.bigthing)
                }
                Notifier.attention(this, title, payload.optString("text"))
            }
            "thingmaker://job" -> if (payload.optString("status") == "failed" && toldJobs.add(payload.optString("id"))) {
                Notifier.attention(this, getString(R.string.job_failed), "${payload.optString("worker")}: ${payload.optString("error").take(200)}")
            }
        }
    }

    companion object {
        private const val ONGOING = 1

        @Volatile
        private var instance: BridgeService? = null

        /** Tells the computer; kept for the next connection when there is none now. */
        fun report(context: Context, id: String, state: String, message: String?) {
            val service = instance
            val socket = service?.socket
            if (socket != null && socket.send(JSONObject().put("t", "install_status").put("id", id).put("state", state).put("message", message ?: JSONObject.NULL).toString())) return
            context.getSharedPreferences("install", Context.MODE_PRIVATE).edit().putString("pending:$id", state).apply()
        }
    }
}
