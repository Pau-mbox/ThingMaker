package dev.thingmaker.remote

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
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
import android.provider.OpenableColumns
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowInsets
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.webkit.WebViewAssetLoader
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The phone's ThingMaker: ThingMaker's own screens, bundled in this app and
 * served from a local origin, talking to the paired computer over a socket
 * this app opens — through the computer's Cloudflare relay or directly
 * through the user's tunnel, whichever it was paired with.
 *
 * Native code owns the line and its secrets: it adds the Cloudflare Access
 * headers and sends this phone's token itself, so neither ever reaches the
 * page. Optionally locked behind the fingerprint or screen lock, because what
 * is inside can run agents on the computer.
 */
class MainActivity : Activity() {
    private lateinit var pairing: Pairing
    private lateinit var web: WebView
    private lateinit var cover: LinearLayout
    private lateinit var coverText: TextView
    private lateinit var coverAction: Button
    private lateinit var coverSecond: Button
    private var unlocked = false
    private var loaded = false
    private var backgroundedAt = 0L
    /** The page's file requests waiting on Android's pickers. */
    private var picking: String? = null
    private var saving: Pair<String, String>? = null

    override fun attachBaseContext(newBase: Context) = super.attachBaseContext(AppSettings.localized(newBase))

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pairing = Pairing.load(this) ?: return pairAgain(intent.getStringExtra(DEV_OFFER))
        Notifier.channels(this)

        val assets = WebViewAssetLoader.Builder().addPathHandler("/app/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web = WebView(this).apply {
            setBackgroundColor(PairActivity.BACKGROUND)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mediaPlaybackRequiresUserGesture = true
            settings.setSupportMultipleWindows(false)
            addJavascriptInterface(NativeBridge(), "ThingMakerNative")
            webViewClient = Client(assets)
            // The page's confirm() and alert() as Android dialogs.
            webChromeClient = WebChromeClient()
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
            // MATCH_PARENT, or Chromium resolves vh to 0 and the panels collapse.
            addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(cover, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            // Edge to edge: keep the screens clear of the bars and the
            // keyboard, so the composer stays above it.
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
        if (::web.isInitialized && unlocked && AppSettings.lockEnabled(this) && backgroundedAt > 0 && SystemClock.elapsedRealtime() - backgroundedAt > RELOCK_MS) {
            unlocked = false
            unlock()
        }
    }

    override fun onPause() {
        super.onPause()
        App.foreground = false
        backgroundedAt = SystemClock.elapsedRealtime()
    }

    /** The fingerprint, or the screen lock, when the lock is on; skipped on a phone with neither. */
    private fun unlock() {
        val manager = getSystemService(android.hardware.biometrics.BiometricManager::class.java)
        if (!AppSettings.lockEnabled(this) || manager.canAuthenticate(BIOMETRIC_WEAK or DEVICE_CREDENTIAL) != android.hardware.biometrics.BiometricManager.BIOMETRIC_SUCCESS) {
            unlocked = true
            open()
            return
        }
        showCover(getString(R.string.locked), getString(R.string.unlock), { unlock() })
        BiometricPrompt.Builder(this)
            .setTitle(getString(R.string.unlock_title))
            .setSubtitle(getString(R.string.unlock_subtitle, pairing.macName))
            .setAllowedAuthenticators(BIOMETRIC_WEAK or DEVICE_CREDENTIAL)
            .build()
            .authenticate(CancellationSignal(), mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    unlocked = true
                    open()
                }
            })
    }

    /**
     * The bundled screens. They open at once, even offline; whether the
     * computer is there shows in their own connection banner.
     */
    private fun open() {
        if (!loaded) {
            loaded = true
            web.loadUrl(SCREENS)
            startBridge()
        } else {
            hideCover()
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

    private fun pairAgain(devOffer: String? = null) {
        val pair = Intent(this, PairActivity::class.java)
        // A debuggable build may be handed a pairing offer at launch, so an
        // emulator pairs without scanning; an installed build ignores it.
        if (devOffer != null && applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) pair.putExtra(DEV_OFFER, devOffer)
        startActivity(pair)
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

    private inner class Client(private val assets: WebViewAssetLoader) : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String) {
            if (unlocked && url.startsWith(ORIGIN)) hideCover()
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (request.url.host == HOST) return false
            // Anything else opens outside: the screens never leave the app.
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
            return true
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = assets.shouldInterceptRequest(request.url)
    }

    // --- What the screens may ask of the phone --------------------------------

    /** The screens' sockets, opened here with the Access headers and the hello. */
    private val sockets = ConcurrentHashMap<String, WebSocket>()

    /** Hands a value to the page's waiting callback. */
    private fun toPage(script: String) = runOnUiThread {
        if (::web.isInitialized) web.evaluateJavascript(script, null)
    }

    private fun socketEvent(id: String, kind: String, data: String) =
        toPage("window.__thingmakerSocket && window.__thingmakerSocket(${JSONObject.quote(id)}, '$kind', ${JSONObject.quote(data)})")

    private fun answer(id: String, value: Any?) {
        val json = when (value) {
            null -> "null"
            is String -> JSONObject.quote(value)
            else -> value.toString()
        }
        toPage("window.__thingmakerAnswer && window.__thingmakerAnswer(${JSONObject.quote(id)}, $json)")
    }

    override fun onDestroy() {
        sockets.values.forEach { it.close(1001, "closing") }
        sockets.clear()
        super.onDestroy()
    }

    @Deprecated("Activity's own result path; this app has no AndroidX activity.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            PICK -> {
                val id = picking ?: return
                picking = null
                val uris = buildList {
                    data?.clipData?.let { clip -> for (i in 0 until clip.itemCount) add(clip.getItemAt(i).uri) }
                    if (isEmpty()) data?.data?.let(::add)
                }.take(MAX_FILES)
                if (resultCode != RESULT_OK || uris.isEmpty()) return answer(id, JSONArray())
                thread {
                    val files = JSONArray()
                    for (uri in uris) read(uri)?.let { (name, bytes) -> files.put(JSONObject().put("name", name).put("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))) }
                    answer(id, files)
                }
            }
            SAVE -> {
                val (id, content) = saving ?: return
                saving = null
                val uri = data?.data
                if (resultCode != RESULT_OK || uri == null) return answer(id, null)
                thread {
                    val saved = runCatching { contentResolver.openOutputStream(uri)?.use { it.write(content.toByteArray(Charsets.UTF_8)) } }.isSuccess
                    answer(id, if (saved) uri.toString() else null)
                }
            }
        }
    }

    /** A picked file's name and bytes, if it is small enough to attach. */
    private fun read(uri: Uri): Pair<String, ByteArray>? = runCatching {
        var name = "attachment"
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) name = it.getString(0) ?: name }
        val output = ByteArrayOutputStream()
        contentResolver.openInputStream(uri)!!.use { stream ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = stream.read(buffer)
                if (count < 0) break
                if (output.size() + count > MAX_ATTACHMENT) return null
                output.write(buffer, 0, count)
            }
        }
        name to output.toByteArray()
    }.getOrNull()

    private inner class NativeBridge {
        /** A socket to the computer; the hello with this phone's token is sent here, not by the page. */
        @JavascriptInterface
        fun socketOpen(path: String): String {
            val id = UUID.randomUUID().toString()
            val request = pairing.authorize(Request.Builder().url(pairing.socketUrl(path))).build()
            sockets[id] = SOCKETS.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send(pairing.hello())
                    socketEvent(id, "open", "")
                }
                override fun onMessage(webSocket: WebSocket, text: String) = socketEvent(id, "message", text)
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (sockets.remove(id) != null) socketEvent(id, "close", "")
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    // Why the line would not open, for the page's banner.
                    val why = when (response?.code) {
                        503 -> "relay-without-computer"
                        302, 401, 403 -> "access-refused"
                        null -> "unreachable"
                        else -> "answered-${response.code}"
                    }
                    if (sockets.remove(id) != null) socketEvent(id, "close", why)
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
        fun macName(): String = pairing.macName

        /** `relay` or `direct`: how this phone reaches the computer. */
        @JavascriptInterface
        fun connectionMode(): String = pairing.mode

        @JavascriptInterface
        fun address(): String = pairing.url

        /** Files from Android's picker, answered as `[{name, dataBase64}]`. */
        @JavascriptInterface
        fun pickFiles(id: String) {
            runOnUiThread {
                picking = id
                @Suppress("DEPRECATION")
                startActivityForResult(
                    Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true),
                    PICK,
                )
            }
        }

        /** Saves text where the person chooses; answered with its address, or null. */
        @JavascriptInterface
        fun saveText(id: String, name: String, content: String) {
            runOnUiThread {
                saving = id to content
                @Suppress("DEPRECATION")
                startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("text/plain").putExtra(Intent.EXTRA_TITLE, name), SAVE)
            }
        }

        @JavascriptInterface
        fun lockEnabled(): Boolean = AppSettings.lockEnabled(this@MainActivity)

        @JavascriptInterface
        fun setLockEnabled(enabled: Boolean) = AppSettings.setLockEnabled(this@MainActivity, enabled)

        @JavascriptInterface
        fun language(): String = AppSettings.language(this@MainActivity)

        /** The app's own screens follow at once; the page reloads itself. */
        @JavascriptInterface
        fun setLanguage(language: String) {
            AppSettings.setLanguage(this@MainActivity, language)
        }

        @JavascriptInterface
        fun notify(title: String, body: String) {
            // Open, the screens already show it; closed, the service tells.
            if (!App.foreground) Notifier.attention(this@MainActivity, title, body)
        }

        @JavascriptInterface
        fun connectionChanged(state: String) {
            if (state == "denied") {
                runOnUiThread { showCover(getString(R.string.revoked, pairing.macName), getString(R.string.pair_again), { forget() }) }
            }
        }

        @JavascriptInterface
        fun unpair() {
            runOnUiThread { forget() }
        }
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    companion object {
        /** The bundled screens' origin: local, HTTPS, this app's alone. */
        private const val HOST = "appassets.androidplatform.net"
        private const val ORIGIN = "https://$HOST/app/"
        private const val SCREENS = "${ORIGIN}index.html"
        /** Away longer than this and the app asks for the fingerprint again. */
        private const val RELOCK_MS = 5 * 60_000L
        const val DEV_OFFER = "dev.thingmaker.remote.DEV_OFFER"
        private const val PICK = 41
        private const val SAVE = 42
        private const val MAX_FILES = 8
        /** The computer takes attachments up to 10 MiB. */
        private const val MAX_ATTACHMENT = 10 * 1024 * 1024
        private val SOCKETS = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).pingInterval(25, TimeUnit.SECONDS).build()
    }
}

/** App-wide state the service and the screen share. */
object App {
    @Volatile
    var foreground = false
}
