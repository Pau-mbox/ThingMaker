package dev.thingmaker.phone

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_WEAK
import android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import android.hardware.biometrics.BiometricPrompt
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowInsets
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The phone's ThingMaker: ThingMaker's own screens, served by the paired Mac
 * through its Cloudflare relay, in a WebView. Locked behind the phone's fingerprint or
 * screen lock, because what is inside can run agents on the Mac.
 */
class MainActivity : Activity() {
    private lateinit var pairing: Pairing
    private lateinit var web: WebView
    private lateinit var cover: LinearLayout
    private lateinit var coverText: TextView
    private lateinit var coverAction: Button
    private lateinit var coverSecond: Button
    private var base: String? = null
    private var unlocked = false
    private var backgroundedAt = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pairing = Pairing.load(this) ?: return pairAgain()
        Notifier.channels(this)

        web = WebView(this).apply {
            setBackgroundColor(PairActivity.BACKGROUND)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = true
            addJavascriptInterface(NativeBridge(), "ThingMakerNative")
            webViewClient = Client()
            visibility = View.INVISIBLE
        }
        coverText = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 17f
            gravity = Gravity.CENTER
        }
        coverAction = Button(this).apply { isAllCaps = false }
        coverSecond = Button(this).apply { isAllCaps = false }
        cover = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(32), dp(32), dp(32))
            setBackgroundColor(PairActivity.BACKGROUND)
            addView(coverText, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(coverAction, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = dp(24) })
            addView(coverSecond, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = dp(8) })
        }
        val root = FrameLayout(this).apply {
            setBackgroundColor(PairActivity.BACKGROUND)
            addView(web, MATCH_PARENT, MATCH_PARENT)
            addView(cover, MATCH_PARENT, MATCH_PARENT)
            // Edge to edge: keep the screens clear of the bars and the keyboard.
            setOnApplyWindowInsetsListener { view, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                WindowInsets.CONSUMED
            }
        }
        setContentView(root)
        unlock()
    }

    override fun onResume() {
        super.onResume()
        App.foreground = true
        if (::web.isInitialized && unlocked && backgroundedAt > 0 && SystemClock.elapsedRealtime() - backgroundedAt > RELOCK_MS) {
            unlocked = false
            unlock()
        }
    }

    override fun onPause() {
        super.onPause()
        App.foreground = false
        backgroundedAt = SystemClock.elapsedRealtime()
    }

    /** The fingerprint, or the screen lock; skipped on a phone with neither. */
    private fun unlock() {
        showCover("Locked", "Unlock", { unlock() })
        val manager = getSystemService(android.hardware.biometrics.BiometricManager::class.java)
        if (manager.canAuthenticate(BIOMETRIC_WEAK or DEVICE_CREDENTIAL) != android.hardware.biometrics.BiometricManager.BIOMETRIC_SUCCESS) {
            unlocked = true
            connect()
            return
        }
        BiometricPrompt.Builder(this)
            .setTitle("Unlock ThingMaker")
            .setSubtitle("It can run agents on ${pairing.macName}")
            .setAllowedAuthenticators(BIOMETRIC_WEAK or DEVICE_CREDENTIAL)
            .build()
            .authenticate(CancellationSignal(), mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    unlocked = true
                    if (base == null) connect() else hideCover()
                }
            })
    }

    /**
     * Reaches the Mac through its relay, then loads its screens. Cloudflare
     * Access only lets requests through with the service token's headers, and
     * sets no cookie for it, so the app fetches every page file itself
     * ([Client.shouldInterceptRequest]) and opens the screens' WebSocket
     * ([NativeBridge.socketOpen]).
     */
    private fun connect() {
        showCover("Reaching ${pairing.macName}…", null, null)
        thread {
            val problem: String? = try {
                PROBE.newCall(pairing.authorize(Request.Builder().url("${pairing.url}/v1/hello")).build()).execute().use { response ->
                    when {
                        response.isSuccessful -> null
                        response.code == 503 -> "The relay is up, but ThingMaker on ${pairing.macName} is not connected to it. Is it running there with phone access on?"
                        response.code in listOf(302, 401, 403) -> "Cloudflare Access turned this phone away. Pair again from the Mac's Settings → Phone to pick up the current service token."
                        else -> "The relay answered ${response.code}."
                    }
                }
            } catch (error: Exception) {
                "Can't reach the relay: ${error.message}\n\nIs this phone online?"
            }
            runOnUiThread {
                if (problem != null) {
                    showCover(problem, "Try again", { connect() }, "Pair with another Mac", { forget() })
                } else {
                    base = pairing.url
                    web.loadUrl("${pairing.url}/app/", pairing.accessHeaders())
                    startBridge()
                }
            }
        }
    }

    private fun startBridge() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        startForegroundService(Intent(this, BridgeService::class.java))
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        startForegroundService(Intent(this, BridgeService::class.java))
    }

    private fun showCover(message: String, action: String?, onAction: (() -> Unit)?, second: String? = null, onSecond: (() -> Unit)? = null) {
        cover.visibility = View.VISIBLE
        web.visibility = View.INVISIBLE
        coverText.text = message
        coverAction.visibility = if (action == null) View.GONE else View.VISIBLE
        coverAction.text = action ?: ""
        coverAction.setOnClickListener { onAction?.invoke() }
        coverSecond.visibility = if (second == null) View.GONE else View.VISIBLE
        coverSecond.text = second ?: ""
        coverSecond.setOnClickListener { onSecond?.invoke() }
    }

    private fun hideCover() {
        cover.visibility = View.GONE
        web.visibility = View.VISIBLE
    }

    private fun forget() {
        stopService(Intent(this, BridgeService::class.java))
        Pairing.clear(this)
        pairAgain()
    }

    private fun pairAgain() {
        startActivity(Intent(this, PairActivity::class.java))
        finish()
    }

    @Deprecated("The screens decide what back means; Android's own back follows them.")
    override fun onBackPressed() {
        if (!::web.isInitialized || web.visibility != View.VISIBLE) {
            moveTaskToBack(true)
            return
        }
        web.evaluateJavascript("window.__thingmakerBack ? window.__thingmakerBack() : false") { handled ->
            if (handled != "true") moveTaskToBack(true)
        }
    }

    private inner class Client : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String) {
            if (unlocked && url.startsWith(base ?: "\u0000")) hideCover()
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (base != null && url.startsWith(base!!)) return false
            // Anything else opens outside: the screens never leave the Mac.
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            return true
        }

        /** The screens' own files, fetched with the Access headers the WebView cannot add. */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val origin = base ?: return null
            val url = request.url.toString()
            if (request.method != "GET" || !url.startsWith(origin)) return null
            return runCatching {
                val builder = Request.Builder().url(url)
                request.requestHeaders.forEach { (name, value) ->
                    // OkHttp unzips only what it asked to be zipped.
                    if (!name.equals("Accept-Encoding", true) && !name.equals("Cookie", true)) builder.header(name, value)
                }
                val response = FETCH.newCall(pairing.authorize(builder).build()).execute()
                val type = response.header("Content-Type") ?: "application/octet-stream"
                val charset = Regex("charset=([^;]+)", RegexOption.IGNORE_CASE).find(type)?.groupValues?.get(1)?.trim()
                val headers = response.headers.toMultimap()
                    .filterKeys { it.lowercase() !in setOf("content-type", "content-encoding", "content-length", "transfer-encoding") }
                    .mapValues { it.value.joinToString(", ") }
                WebResourceResponse(type.substringBefore(';').trim(), charset, response.code, response.message.ifBlank { "OK" }, headers, response.body!!.byteStream())
            }.getOrNull()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) {
                base = null
                showCover("Lost ${pairing.macName}: ${error.description}", "Reconnect", { connect() })
            }
        }
    }

    /** What the screens may ask of the phone. */
    /** The screens' WebSockets, opened by the app with the Access headers. */
    private val sockets = ConcurrentHashMap<String, WebSocket>()

    private fun toPage(id: String, kind: String, data: String) = runOnUiThread {
        if (::web.isInitialized) web.evaluateJavascript("window.__thingmakerSocket && window.__thingmakerSocket(${JSONObject.quote(id)}, '$kind', ${JSONObject.quote(data)})", null)
    }

    override fun onDestroy() {
        sockets.values.forEach { it.close(1001, "closing") }
        sockets.clear()
        super.onDestroy()
    }

    private inner class NativeBridge {
        @JavascriptInterface
        fun socketOpen(path: String): String {
            val id = UUID.randomUUID().toString()
            val request = pairing.authorize(Request.Builder().url(pairing.socketUrl(path))).build()
            sockets[id] = SOCKETS.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) = toPage(id, "open", "")
                override fun onMessage(webSocket: WebSocket, text: String) = toPage(id, "message", text)
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (sockets.remove(id) != null) toPage(id, "close", "")
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (sockets.remove(id) != null) toPage(id, "close", "")
                }
            })
            return id
        }

        @JavascriptInterface
        fun socketSend(id: String, data: String) {
            sockets[id]?.send(data)
        }

        @JavascriptInterface
        fun socketClose(id: String) {
            // The page hears the close when OkHttp reports it.
            sockets[id]?.close(1000, null)
        }

        @JavascriptInterface
        fun token(): String = pairing.token

        @JavascriptInterface
        fun macName(): String = pairing.macName

        @JavascriptInterface
        fun notify(title: String, body: String) {
            // Open, the screens already show it; closed, the service tells.
            if (!App.foreground) Notifier.attention(this@MainActivity, title, body)
        }

        @JavascriptInterface
        fun connectionChanged(state: String) {
            if (state == "denied") {
                runOnUiThread {
                    showCover("${pairing.macName} no longer knows this phone: its pairing was revoked there.", "Pair again", { forget() })
                }
            }
        }

        @JavascriptInterface
        fun unpair() {
            runOnUiThread { forget() }
        }
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    companion object {
        /** Away longer than this and the app asks for the fingerprint again. */
        private const val RELOCK_MS = 5 * 60_000L
        private val PROBE = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).build()
        private val FETCH = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
        private val SOCKETS = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).pingInterval(25, TimeUnit.SECONDS).build()
    }
}

/** App-wide state the service and the screen share. */
object App {
    @Volatile
    var foreground = false
}
