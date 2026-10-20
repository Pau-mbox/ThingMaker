package dev.thingmaker.remote

import android.content.Context
import android.content.res.Configuration
import java.util.Locale

/**
 * The app's own choices, set from the screens' Settings: whether opening it
 * asks for the fingerprint or screen lock, and its language.
 */
object AppSettings {
    private fun prefs(context: Context) = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    /** On unless turned off: what is inside can run agents on the computer. */
    fun lockEnabled(context: Context): Boolean = prefs(context).getBoolean("lock", true)

    fun setLockEnabled(context: Context, enabled: Boolean) = prefs(context).edit().putBoolean("lock", enabled).apply()

    /** `system`, `en` or `es`. */
    fun language(context: Context): String = prefs(context).getString("language", "system") ?: "system"

    fun setLanguage(context: Context, language: String) = prefs(context).edit().putString("language", language).apply()

    /** A context in the chosen language, for an activity's or a service's `attachBaseContext`. */
    fun localized(base: Context): Context {
        val language = language(base)
        if (language == "system") return base
        val config = Configuration(base.resources.configuration)
        config.setLocale(Locale.forLanguageTag(language))
        return base.createConfigurationContext(config)
    }
}
