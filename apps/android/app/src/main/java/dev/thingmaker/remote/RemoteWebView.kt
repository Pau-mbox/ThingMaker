package dev.thingmaker.remote

import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.*
import android.widget.EditText
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.JavaScriptReplyProxy
import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** API key stays in native memory/Keystore, never in JS, URLs or page storage. */
class RemoteWebView(private val activity: MainActivity, private val url: String, private val secret: String, private val disconnect: () -> Unit) : WebView(activity) {
    private val handler = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).connectTimeout(15, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()
    @Volatile private var socket: WebSocket? = null
    private var reply: JavaScriptReplyProxy? = null
    private var stopped = false
    private val attachmentResponses = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val reconnect = Runnable { if (!stopped) connect() }
    init {
        if ((activity.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true)
        check(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { "Actualiza Android System WebView para usar ThingMaker" }
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.blockNetworkLoads = true
        settings.setSupportMultipleWindows(false)
        val loader = WebViewAssetLoader.Builder().addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(activity)).build()
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == "appassets.androidplatform.net") return false
                if (request.isForMainFrame) external(request.url.toString())
                return true
            }
        }
        WebViewCompat.addWebMessageListener(this, "ThingMakerNative", setOf("https://appassets.androidplatform.net")) { _, message, origin, mainFrame, proxy ->
            if (mainFrame && origin.host == "appassets.androidplatform.net") {
                reply = proxy
                try { receive(JSONObject(message.data ?: "{}")) } catch (_: Exception) { }
            }
        }
        loadUrl("https://appassets.androidplatform.net/index.html")
    }
    private fun emit(value: JSONObject) { handler.post { if (!stopped) reply?.postMessage(value.toString()) } }
    private fun status(value: String) = emit(JSONObject().put("status", value))
    private fun result(frame: JSONObject, value: Any?) = emit(JSONObject().put("id", frame.getString("id")).put("result", value ?: JSONObject.NULL))
    private fun error(frame: JSONObject, message: String) = emit(JSONObject().put("id", frame.getString("id")).put("error", JSONObject().put("code", "UNSUPPORTED").put("message", message).put("retry", "user_action")))
    private fun external(value: String) {
        val uri = Uri.parse(value)
        if (uri.scheme == "https" || uri.scheme == "http") activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
    }
    private fun receive(frame: JSONObject) {
        when (frame.optString("command")) {
            "hello" -> if (socket == null) connect()
            "disconnect", "app_quit", "app_hide_to_tray" -> { stop(); disconnect() }
            "open_external" -> { external(frame.optJSONObject("args")?.optString("url") ?: ""); result(frame, null) }
            "workspace_pick" -> {
                val entry = EditText(activity).apply { hint = "D:\\repos\\mi-proyecto"; setSingleLine(true) }
                AlertDialog.Builder(activity).setTitle("Carpeta del proyecto en el PC").setMessage("Introduce la ruta de una carpeta del ordenador.").setView(entry)
                    .setPositiveButton("Abrir") { _, _ -> result(frame, entry.text.toString()) }.setNegativeButton("Cancelar") { _, _ -> result(frame, null) }.setOnCancelListener { result(frame, null) }.show()
            }
            "confirm_dialog" -> {
                val request = frame.getJSONObject("args").getJSONObject("request")
                AlertDialog.Builder(activity).setTitle(request.optString("title")).setMessage(request.optString("message"))
                    .setPositiveButton(request.optString("okLabel", "Aceptar")) { _, _ -> result(frame, true) }.setNegativeButton(request.optString("cancelLabel", "Cancelar")) { _, _ -> result(frame, false) }.setOnCancelListener { result(frame, false) }.show()
            }
            "save_text_file" -> {
                val request = frame.getJSONObject("args").getJSONObject("request")
                activity.saveDocument(request.optString("suggestedName", "ThingMaker.txt"), request.optString("content")) { saved -> result(frame, saved) }
            }
            "attachment_pick" -> activity.pickAttachment { name, data ->
                if (name.isEmpty()) result(frame, org.json.JSONArray())
                else {
                    attachmentResponses.add(frame.getString("id"))
                    val upload = JSONObject().put("id", frame.getString("id")).put("command", "attachment_add_bytes").put("args", JSONObject().put("request", JSONObject().put("name", name).put("dataBase64", data)))
                    if (socket?.send(upload.toString()) != true) { attachmentResponses.remove(frame.getString("id")); error(frame, "No se pudo adjuntar el archivo. Comprueba la conexión.") }
                }
            }
            "provider_login_start", "provider_login_cancel" -> error(frame, "Inicia sesión en el proveedor desde ThingMaker en el PC. Después podrás utilizarlo aquí.")
            "reveal_in_finder", "open_in_editor" -> error(frame, "Abre Archivos o Cambios para revisar el proyecto en el móvil. El editor externo se abre desde el PC.")
            else -> if (socket?.send(frame.toString()) != true) error(frame, "Conexión interrumpida. Revisa el estado antes de repetir la acción.")
        }
    }
    private fun connect() {
        if (stopped) return
        val request = Request.Builder().url("${url.trimEnd('/').replaceFirst("https://", "wss://")}/v2/ws").header("Authorization", "Bearer $secret").header("User-Agent", "ThingMakerRemote/2.0").build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) { if (socket === webSocket) try {
                val frame = JSONObject(text)
                if (attachmentResponses.remove(frame.optString("id")) && frame.has("result")) frame.put("result", org.json.JSONArray().put(frame.get("result")))
                emit(frame)
            } catch (_: Exception) { } }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (socket !== webSocket || stopped) return
                handler.post {
                    if (response?.code == 401) { status("unauthorized"); socket = null }
                    else { status(if (response?.code == 404) "update-required" else "offline"); handler.removeCallbacks(reconnect); handler.postDelayed(reconnect, 4000) }
                }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (socket !== webSocket || stopped) return
                handler.post { status(if (code == 1008) "unauthorized" else "offline"); if (code != 1008) handler.postDelayed(reconnect, 4000) }
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason); if (code == 1008) status("unauthorized") }
        })
    }
    fun stop() { stopped = true; handler.removeCallbacks(reconnect); socket?.close(1000, "Phone disconnected"); socket = null; client.dispatcher.executorService.shutdown() }
    override fun destroy() { stop(); super.destroy() }
}
