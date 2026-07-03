# Katana Agent — prebuilt APK

`katana-agent-v2.7-debug.apk` — debug build, package `shop.glhouse.agent`, versionName **2.7** (versionCode 18).

Includes the widened Paytm detail-screen detection (RRN / UTR / UPI Ref / Transaction ID)
and **node-click navigation** — the auto-sweep now opens transactions via a real
accessibility click (`ACTION_CLICK`) instead of a synthetic gesture Paytm rejects, so
hands-free capture works **without Shizuku**. Coordinate taps remain a fallback.

## Install (sideload)
1. Download the `.apk` onto the phone (or `adb install -r katana-agent-v2.6-debug.apk`).
2. Play Protect will warn on an SMS-reading sideload → **More details → Install anyway**.
3. Open **Katana Agent** and follow the on-screen setup.

## Enable the Paytm RRN capture path
- **Accessibility** button → enable *Katana Agent*.
- Install **Shizuku**, start it, then tap **Shizuku** in the app → status **"Shell-tap: ✓ ready"** (taps Paytm accepts).
- Turn **Auto-capture** ON for the hands-free sweep.
- Open Paytm Business on the payments list; watch **Recent alerts** for capture lines.

> A fresh APK is also produced by CI on every push — see the **Android Agent APK**
> workflow (`.github/workflows/android-agent.yml`) → download the `katana-agent-debug-apk` artifact.
