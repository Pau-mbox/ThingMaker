package dev.thingmaker.remote
import android.os.Bundle
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.*
class MainActivity : ComponentActivity() {
    private var saveContent = ""
    private var saveCallback: ((String?) -> Unit)? = null
    private var attachmentCallback: ((String, String) -> Unit)? = null
    private val createDocument = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.CreateDocument("text/plain")) { uri ->
        val callback = saveCallback; saveCallback = null
        try { if (uri != null) contentResolver.openOutputStream(uri)?.use { it.write(saveContent.toByteArray(Charsets.UTF_8)) }; callback?.invoke(uri?.toString()) }
        catch (_: Exception) { callback?.invoke(null) }; saveContent = ""
    }
    private val openDocument = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenDocument()) { uri ->
        val callback = attachmentCallback; attachmentCallback = null
        if (uri == null) { callback?.invoke("", ""); return@registerForActivityResult }
        lifecycleScope.launch {
            val content = withContext(Dispatchers.IO) {
                try {
                    var name = "attachment"
                    contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor -> if (cursor.moveToFirst()) name = cursor.getString(0) }
                    val output = java.io.ByteArrayOutputStream()
                    contentResolver.openInputStream(uri)!!.use { stream ->
                        val buffer = ByteArray(8192)
                        while (true) { val count = stream.read(buffer); if (count < 0) break; require(output.size() + count <= 8 * 1024 * 1024); output.write(buffer, 0, count) }
                    }
                    Pair(name, Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
                } catch (_: Exception) { Pair("", "") }
            }; callback?.invoke(content.first, content.second)
        }
    }
    fun saveDocument(name: String, content: String, callback: (String?) -> Unit) { saveContent = content; saveCallback = callback; createDocument.launch(name) }
    fun pickAttachment(callback: (String, String) -> Unit) { attachmentCallback = callback; openDocument.launch(arrayOf("image/*", "audio/*")) }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = android.graphics.Color.rgb(17, 17, 19)
        window.navigationBarColor = android.graphics.Color.rgb(17, 17, 19)
        val vault = Vault(this)
        setContent { MaterialTheme(colorScheme = darkColorScheme()) { Surface(Modifier.fillMaxSize().systemBarsPadding()) { Remote(vault, this) } } }
    }
}
@Composable private fun Remote(vault: Vault, activity: MainActivity) {
    val saved = remember { vault.read() }
    var url by remember { mutableStateOf(saved.first) }
    var secret by remember { mutableStateOf(saved.second) }
    var api by remember { mutableStateOf<Api?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    fun connect() { if (!busy) scope.launch {
        busy = true; error = ""
        try { val candidate = Api(url.trim().trimEnd('/'), secret.trim()); candidate.call("workspaces"); vault.save(candidate.url, candidate.key); api = candidate }
        catch (e: Exception) { error = e.message ?: "No se pudo conectar" }; busy = false
    } }
    LaunchedEffect(Unit) { if (secret.isNotBlank()) connect() }
    val connection = api
    if (connection != null) {
        var web by remember { mutableStateOf<RemoteWebView?>(null) }
        DisposableEffect(connection) { onDispose { web?.destroy(); web = null } }
        BackHandler { if (web?.canGoBack() == true) web?.goBack() else web?.evaluateJavascript("window.dispatchEvent(new CustomEvent('thingmaker-mobile-back'))", null) }
        androidx.compose.ui.viewinterop.AndroidView(modifier = Modifier.fillMaxSize(), factory = { RemoteWebView(activity, connection.url, connection.key) { api = null; secret = ""; vault.clear() }.also { web = it } })
    } else {
        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("ThingMaker", style = MaterialTheme.typography.headlineLarge)
            Text("La misma interfaz del PC, desde tu móvil. Las tareas se ejecutan en el ordenador.")
            OutlinedTextField(url, { url = it }, label = { Text("Servidor HTTPS") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(secret, { secret = it }, label = { Text("API key del PC") }, visualTransformation = PasswordVisualTransformation(), singleLine = true, modifier = Modifier.fillMaxWidth())
            Text("Copia la clave desde Settings → Control remoto Android en ThingMaker del PC. Se guarda cifrada en este móvil.", style = MaterialTheme.typography.bodySmall)
            if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
            Button(onClick = { connect() }, enabled = !busy && secret.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text(if (busy) "Conectando…" else "Conectar") }
        }
    }
}
