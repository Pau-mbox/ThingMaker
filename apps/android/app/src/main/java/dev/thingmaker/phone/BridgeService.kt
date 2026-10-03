package dev.thingmaker.phone

import android.app.Notification
import android.app.NotificationManager
import android.app.Service
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
 * Keeps a line open to the Mac while the app is closed, so the phone hears
 * when a Big Thing asks something, is blocked or is done, and when a
 * worker's job fails. No push service in between: the Mac speaks to this
 * phone over Tailscale directly.
 */
class BridgeService : Service() {
    private val client = OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).connectTimeout(5, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).build()
    private val handler = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var pairing: Pairing? = null
    private var hostIndex = 0
    private var retry = 2_000L
    private var stopped = false
    /** What the ongoing notification says now; a second start keeps it. */
    private var shown: String? = null
    /** A job is told about once, however often it changes after failing. */
    private val toldJobs = mutableSetOf<String>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Notifier.channels(this)
        pairing = Pairing.load(this) ?: run {
            stopSelf()
            return START_NOT_STICKY
        }
        startForeground(ONGOING, ongoing(shown ?: "Connecting to ${pairing!!.macName}…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        if (socket == null) open()
        return START_STICKY
    }

    override fun onDestroy() {
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
        val host = pairing.hosts[hostIndex % pairing.hosts.size]
        val request = Request.Builder().url("ws://$host:${pairing.port}/v1/ws").build()
        socket = client.newWebSocket(request, Listener(pairing))
    }

    private fun reconnect() {
        socket = null
        if (stopped) return
        hostIndex++
        handler.postDelayed({ open() }, retry)
        retry = (retry * 2).coerceAtMost(60_000L)
    }

    private inner class Listener(private val pairing: Pairing) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send(JSONObject().put("t", "hello").put("token", pairing.token).put("client", "thingmaker-phone-service").toString())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val frame = runCatching { JSONObject(text) }.getOrNull() ?: return
            when (frame.optString("t")) {
                "welcome" -> {
                    retry = 2_000L
                    status("Connected to ${pairing.macName}")
                }
                "denied" -> {
                    stopped = true
                    Notifier.attention(this@BridgeService, "Pairing revoked", "${pairing.macName} no longer knows this phone. Open the app to pair again.")
                    stopSelf()
                }
                "event" -> event(frame.optString("name"), frame.optJSONObject("payload"))
            }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            status("Waiting for ${pairing.macName}…")
            reconnect()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            status("Waiting for ${pairing.macName}…")
            reconnect()
        }
    }

    /** What reaches the phone while the app is closed. */
    private fun event(name: String, payload: JSONObject?) {
        if (payload == null || App.foreground) return
        when (name) {
            "thingmaker://bigthing" -> if (payload.optString("kind") == "notify") {
                val title = when (payload.optString("attention")) {
                    "needs_input" -> "Big Thing needs you"
                    "blocked" -> "Big Thing is blocked"
                    "done" -> "Big Thing is done"
                    else -> "Big Thing"
                }
                Notifier.attention(this, title, payload.optString("text"))
            }
            "thingmaker://job" -> if (payload.optString("status") == "failed" && toldJobs.add(payload.optString("id"))) {
                Notifier.attention(this, "A worker's job failed", "${payload.optString("worker")}: ${payload.optString("error").take(200)}")
            }
        }
    }

    companion object {
        private const val ONGOING = 1
    }
}
