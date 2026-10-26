plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.thingmaker.remote"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.thingmaker.remote"
        // Android 11: the device-credential fallback for the fingerprint unlock.
        minSdk = 30
        targetSdk = 35
        versionCode = 7
        versionName = "3.0.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Sideloaded onto your own phone: the debug key is the signature.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Serves the bundled screens from a local HTTPS origin.
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
