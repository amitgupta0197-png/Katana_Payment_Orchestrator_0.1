import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing: read keystore creds from keystore.properties (git-ignored). When
// the file is absent (e.g. a fresh checkout) the release build falls back to unsigned.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply { if (keystorePropsFile.exists()) load(keystorePropsFile.inputStream()) }

// HMAC key the agent signs device requests with. MUST equal the server's
// AGENT_SIGNING_SECRET. Hoisted out of defaultConfig so the release guard below can see it.
val DEV_SIGNING_SECRET = "dev-agent-signing-secret"
val agentSigningSecret: String = (keystoreProps["agentSigningSecret"] as String?)
    ?: (project.findProperty("agentSigningSecret") as String?)
    ?: DEV_SIGNING_SECRET

android {
    namespace = "shop.glhouse.agent"
    compileSdk = 34

    defaultConfig {
        applicationId = "shop.glhouse.agent"
        minSdk = 24
        targetSdk = 34
        versionCode = 53
        versionName = "2.39"

        buildConfigField("String", "AGENT_SIGNING_SECRET", "\"$agentSigningSecret\"")
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    signingConfigs {
        if (keystorePropsFile.exists()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps["storeFile"] as String)
                storePassword = keystoreProps["storePassword"] as String
                keyAlias = keystoreProps["keyAlias"] as String
                keyPassword = keystoreProps["keyPassword"] as String
            }
        }
    }

    // A release APK built with the dev fallback secret can never authenticate: it 401s on
    // every device route, so the phone silently fails to enroll. That shipped once
    // (2026-08-05) because keystore.properties had no agentSigningSecret and the build
    // quietly fell through to the default. Refuse to produce such an APK at all.
    tasks.matching { it.name.startsWith("assemble") && it.name.contains("Release") }
        .configureEach {
            doFirst {
                if (agentSigningSecret == DEV_SIGNING_SECRET) error(
                    "Refusing to build a release APK with the dev signing secret.\n" +
                    "Set agentSigningSecret in keystore.properties (git-ignored), or pass\n" +
                    "-PagentSigningSecret=<value>. It MUST equal the server's AGENT_SIGNING_SECRET.",
                )
            }
        }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystorePropsFile.exists()) signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
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
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
