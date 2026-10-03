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
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The phone's ThingMaker: ThingMaker's own screens, served by the paired Mac
 * over Tailscale, in a WebView. Locked behind the phone's fingerprint or
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

    /** Finds the Mac on any of its addresses, then loads its screens. */
    private fun connect() {
        showCover("Reaching ${pairing.macName}…", null, null)
        thread {
            val found = pairing.baseUrls().firstOrNull { url ->
                runCatching { PROBE.newCall(Request.Builder().url("$url/v1/hello").build()).execute().use { it.isSuccessful } }.getOrDefault(false)
            }
            runOnUiThread {
                if (found == null) {
                    showCover(
                        "Can't reach ${pairing.macName}.\n\nIs Tailscale on, on this phone and on the Mac? Is ThingMaker running there with phone access on?",
                        "Try again",
                        { connect() },
                        "Pair with another Mac",
                        { forget() },
                    )
                } else {
                    base = found
                    web.loadUrl("$found/app/")
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

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) {
                base = null
                showCover("Lost ${pairing.macName}: ${error.description}", "Reconnect", { connect() })
            }
        }
    }

    /** What the screens may ask of the phone. */
    private inner class NativeBridge {
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
        private val PROBE = OkHttpClient.Builder().connectTimeout(3, TimeUnit.SECONDS).readTimeout(3, TimeUnit.SECONDS).build()
    }
}

/** App-wide state the service and the screen share. */
object App {
    @Volatile
    var foreground = false
}
