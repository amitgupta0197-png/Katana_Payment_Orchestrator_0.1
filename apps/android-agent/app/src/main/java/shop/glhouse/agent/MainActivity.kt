package shop.glhouse.agent

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import shop.glhouse.agent.databinding.ActivityMainBinding
import kotlin.concurrent.thread
import kotlin.random.Random

class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        b.baseUrl.setText(Prefs.baseUrl(this))
        b.deviceId.setText(Prefs.deviceId(this))
        b.merchantCode.setText(Prefs.merchantCode(this))
        b.enabled.isChecked = Prefs.enabled(this)

        handleControlIntent(intent)

        b.saveBtn.setOnClickListener {
            Prefs.save(this, b.baseUrl.text.toString(), b.deviceId.text.toString(), b.merchantCode.text.toString(), b.enabled.isChecked)
            refreshState()
            AgentWorker.schedule(this)
            if (Prefs.enabled(this)) {
                toast("Saved — connecting to server…")
                // Confirm the phone can actually reach Katana so the merchant sees a
                // real result instead of a silent "(save to verify)".
                AlertUploader.heartbeat(this, notifAccessGranted()) { reachable ->
                    runOnUiThread {
                        refreshState()
                        toast(if (reachable) "Connected to server ✓" else "Can't reach server — check the phone's internet")
                    }
                }
                KeepAliveService.start(this)
            } else {
                toast("Settings saved")
                KeepAliveService.stop(this)
            }
            Handler(Looper.getMainLooper()).postDelayed({ refreshState() }, 1600)
        }
        b.smsBtn.setOnClickListener { requestRuntimePerms() }
        b.notifBtn.setOnClickListener { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
        b.batteryBtn.setOnClickListener { requestBatteryExemption() }
        b.accessBtn.setOnClickListener {
            try { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
            catch (e: Exception) { toast("Open Settings → Accessibility → Katana Agent") }
        }
        b.overlayBtn.setOnClickListener {
            try { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))) }
            catch (e: Exception) {
                try { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)) }
                catch (e2: Exception) { toast("Open Settings → Display over other apps → Katana Agent") }
            }
        }
        b.appPaytmSwitch.isChecked = Prefs.captureAppOn(this, Prefs.APP_PAYTM)
        b.appPaytmSwitch.setOnCheckedChangeListener { _, v -> setCaptureApp(Prefs.APP_PAYTM, v) }
        b.appAirtelSwitch.isChecked = Prefs.captureAppOn(this, Prefs.APP_AIRTEL)
        b.appAirtelSwitch.setOnCheckedChangeListener { _, v -> setCaptureApp(Prefs.APP_AIRTEL, v) }
        b.appGpaySwitch.isChecked = Prefs.captureAppOn(this, Prefs.APP_GPAY)
        b.appGpaySwitch.setOnCheckedChangeListener { _, v -> setCaptureApp(Prefs.APP_GPAY, v) }
        b.appPhonepeSwitch.isChecked = Prefs.captureAppOn(this, Prefs.APP_PHONEPE)
        b.appPhonepeSwitch.setOnCheckedChangeListener { _, v -> setCaptureApp(Prefs.APP_PHONEPE, v) }
        b.autoCaptureSwitch.isChecked = Prefs.autoCapture(this)
        b.autoCaptureSwitch.setOnCheckedChangeListener { _, v -> Prefs.setAutoCapture(this, v) }
        b.keepAwakeSwitch.isChecked = Prefs.keepAwake(this)
        b.keepAwakeSwitch.setOnCheckedChangeListener { _, v ->
            Prefs.setKeepAwake(this, v)
            if (v && !Settings.canDrawOverlays(this)) toast("Enable 'Display over other apps' for keep-awake")
            ScreenAwake.apply(this)
        }
        b.testBtn.setOnClickListener { sendTestAlert() }

        b.emailAddr.setText(Prefs.emailAddr(this))
        b.emailStatus.text = if (Prefs.emailConnected(this)) "✓ Connected: ${Prefs.emailAddr(this)}" else "Not connected"
        b.emailSaveBtn.setOnClickListener { saveEmail() }
        b.emailGoogleBtn.setOnClickListener { connectGoogle() }

        AgentWorker.schedule(this)
    }

    /**
     * A CONTROL INTENT MUST WORK ON THE SECOND CALL TOO.
     *
     * These extras used to be read in onCreate only, and MainActivity is declared
     * android:launchMode="singleInstance" — so once the activity existed, Android delivered
     * every later `am start … --ez backfill true` to onNewIntent and the extra was silently
     * dropped. It looked like it worked: the activity came to the front, nothing errored, and
     * the sweep then ran with the ordinary four-scroll budget instead of the 120 a backfill
     * asks for (2026-08-22, on a 478-row list — four rows visited). The same silence applied to
     * `--ez autocapture`, so a request to pause the engine could quietly leave it running while
     * someone navigated the payments app by hand.
     *
     * Handled from both entry points now, and setIntent() keeps getIntent() honest afterwards.
     */
    private fun handleControlIntent(i: Intent?) {
        // BACKFILL AFTER AN OUTAGE. `--ez backfill true` arms one deep sweep: the engine walks
        // the whole payments list instead of stopping where new payments end. Needed on
        // 2026-08-21, when a day of payments went uncaptured and therefore sat BELOW the rows
        // captured after the fix, which the ordinary boundary heuristic reads as "old".
        // Reachable only by someone who can already launch the app on the phone.
        if (i?.getBooleanExtra("backfill", false) == true) {
            RrnAccessibilityService.requestDeepSweep()
            AlertStore.log(this, "backfill requested: sweeping the whole payments list")
        }

        // PAUSE/RESUME THE CAPTURE ENGINE. `--ez autocapture false` stops it driving the screen
        // so the payments app can be navigated by hand (or over ADB) without the sweep opening a
        // payment out from under you; `true` puts it back. autoCapture is what autoModeEnabled()
        // reads, so this gates the sweep without touching Accessibility itself — force-stopping
        // the app to get the same effect revokes the Accessibility grant on OxygenOS, which cost
        // us a live capture window on 2026-08-21.
        if (i?.hasExtra("autocapture") == true) {
            val on = i.getBooleanExtra("autocapture", true)
            Prefs.setAutoCapture(this, on)
            AlertStore.log(this, "auto-capture turned ${if (on) "on" else "off"}")
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleControlIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        refreshState()
        refreshLog()
        // Keep the hero honest while it is being looked at — a static count is indistinguishable
        // from a stalled one.
        b.root.removeCallbacks(heroTicker)
        b.root.postDelayed(heroTicker, 5_000L)
        if (Prefs.enabled(this)) {
            AlertUploader.heartbeat(this, notifAccessGranted())
            thread { AlertUploader.flushOutbox(this) }
            KeepAliveService.start(this)   // keep the process alive for the notif listener
            Handler(Looper.getMainLooper()).postDelayed({ refreshState() }, 1600)
        } else {
            KeepAliveService.stop(this)
        }
    }

    // Toggle a payment app's capture engine; warn when the merchant turns everything
    // off (screen capture then sits idle) and re-report the selection to the server.
    private fun setCaptureApp(app: String, on: Boolean) {
        // Exactly one app may be on — see Prefs.setCaptureAppExclusive for why.
        if (on) Prefs.setCaptureAppExclusive(this, app) else Prefs.setCaptureApp(this, app, false)
        syncAppSwitches()
        if (Prefs.captureApps(this).isEmpty())
            toast("No payment app selected — capture is paused")
        else if (on) toast("Capturing ${labelFor(app)} only")
        if (Prefs.enabled(this)) AlertUploader.heartbeat(this, notifAccessGranted())
    }

    /** The installed package each switch stands for, so the hero can open it. */
    private fun packageFor(app: String): String? = when (app) {
        Prefs.APP_PAYTM -> listOf("com.paytm.business", "net.one97.paytm.merchant")
            .firstOrNull { runCatching { packageManager.getLaunchIntentForPackage(it) }.getOrNull() != null }
        Prefs.APP_AIRTEL -> "com.apbl.merchant"
        Prefs.APP_GPAY -> RrnAccessibilityService.GPAY_PKG
        Prefs.APP_PHONEPE -> "com.phonepe.app.business"
        else -> null
    }

    /**
     * The tile is one line wide, so it needs the brand alone — but chopping suffixes off the full
     * name is guesswork: "Paytm for Business".removeSuffix(" Business") leaves "Paytm for", which
     * is what the phone displayed. Named explicitly instead.
     */
    private fun shortLabelFor(app: String) = when (app) {
        Prefs.APP_PAYTM -> "Paytm"
        Prefs.APP_AIRTEL -> "Airtel"
        Prefs.APP_GPAY -> "Google Pay"
        Prefs.APP_PHONEPE -> "PhonePe"
        else -> app
    }

    private fun labelFor(app: String) = when (app) {
        Prefs.APP_PAYTM -> "Paytm for Business"
        Prefs.APP_AIRTEL -> "Airtel Merchant"
        Prefs.APP_GPAY -> "Google Pay Business"
        Prefs.APP_PHONEPE -> "PhonePe Business"
        else -> app
    }

    /**
     * Redraw the switches from the stored set WITHOUT re-entering setCaptureApp — assigning
     * isChecked fires the listener, which would write again and recurse.
     */
    private fun syncAppSwitches() {
        val pairs = listOf(
            b.appPaytmSwitch to Prefs.APP_PAYTM,
            b.appAirtelSwitch to Prefs.APP_AIRTEL,
            b.appGpaySwitch to Prefs.APP_GPAY,
            b.appPhonepeSwitch to Prefs.APP_PHONEPE,
        )
        pairs.forEach { (sw, _) -> sw.setOnCheckedChangeListener(null) }
        pairs.forEach { (sw, app) -> sw.isChecked = Prefs.captureAppOn(this, app) }
        pairs.forEach { (sw, app) -> sw.setOnCheckedChangeListener { _, v -> setCaptureApp(app, v) } }
    }

    private fun requestRuntimePerms() {
        val perms = mutableListOf(Manifest.permission.RECEIVE_SMS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) perms.add(Manifest.permission.POST_NOTIFICATIONS)
        ActivityCompat.requestPermissions(this, perms.toTypedArray(), 1)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refreshState()
    }

    private fun requestBatteryExemption() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) { toast("Already unrestricted"); return }
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (e: Exception) {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    private fun smsGranted(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED

    private fun notifAccessGranted(): Boolean =
        NotificationManagerCompat.getEnabledListenerPackages(this).contains(packageName)

    private fun batteryExempt(): Boolean =
        (getSystemService(POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)

    private fun overlayGranted(): Boolean = Settings.canDrawOverlays(this)

    private fun accessGranted(): Boolean {
        // The system stores the component in either fully-qualified
        // ("pkg/pkg.RrnAccessibilityService") or short ("pkg/.RrnAccessibilityService") form,
        // so match on the parsed package + class rather than a raw string.
        val want = ComponentName(this, RrnAccessibilityService::class.java)
        val enabled = try {
            Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
        } catch (e: Exception) { null } ?: ""
        return enabled.split(':').any {
            val cn = ComponentName.unflattenFromString(it) ?: return@any false
            cn.packageName == want.packageName &&
                cn.className.trimStart('.').let { c -> c == want.className || want.className.endsWith(".$c") }
        }
    }

    private fun setRow(granted: Boolean, check: View, btn: View) {
        check.visibility = if (granted) View.VISIBLE else View.GONE
        btn.visibility = if (granted) View.GONE else View.VISIBLE
    }

    private fun refreshState() {
        val sms = smsGranted(); val notif = notifAccessGranted(); val batt = batteryExempt()
        val access = accessGranted()
        setRow(sms, b.smsCheck, b.smsBtn)
        setRow(notif, b.notifCheck, b.notifBtn)
        setRow(batt, b.batteryCheck, b.batteryBtn)
        setRow(access, b.accessCheck, b.accessBtn)
        setRow(overlayGranted(), b.overlayCheck, b.overlayBtn)

        // WHAT THIS PHONE IS ACTUALLY DOING, IN THE FIRST LINE.
        //
        // "Agent active" was true whenever the permissions were granted — which is not the same
        // as capturing, and the difference is the whole ballgame. A phone can be "active" with no
        // payment app selected, with auto-capture off, or parked on this very screen instead of
        // the payment app, and it looks identical while capturing nothing. Each of those states
        // now names itself, and says what to do about it.
        val app = Prefs.captureApps(this).firstOrNull()
        val permissionsOk = Prefs.enabled(this) && (sms || notif)
        // `access` is in here because the RRN engines ARE the accessibility service. Without it
        // the phone can still forward notification credits, but it can never read an RRN off a
        // screen — so it is not armed, and the "open the payment app" shortcut below would be
        // inviting the merchant to watch a screen nothing is reading.
        val armed = permissionsOk && app != null && access &&
            Prefs.autoCapture(this) && Prefs.merchantState(this) == 1

        // A CODE THE SERVER HAS NOT CONFIRMED IS NOT A DESTINATION.
        //
        // Captures are stamped with whatever string is in this box, so a wrong one sends real
        // money to the wrong banker — or to nobody. "GUFFI-01 hu" sat saved for hours on
        // 2026-08-22 while the card cheerfully read active, because a typo with an internal
        // space survives trim() and nothing else looked. The phone now refuses to claim it is
        // capturing until the server has recognised the code.
        val codeVerified = Prefs.merchantState(this) == 1
        val hasCode = Prefs.merchantCode(this).isNotBlank()

        val (title, colorRes) = when {
            !permissionsOk -> "Setup needed" to R.color.warning
            !hasCode -> "No merchant code" to R.color.danger
            Prefs.merchantState(this) == -1 -> "Merchant code not recognised" to R.color.danger
            !codeVerified -> "Merchant code unverified" to R.color.warning
            app == null -> "No payment app selected" to R.color.warning
            // THE ENGINES ARE THE ACCESSIBILITY SERVICE, AND AN UPDATE SWITCHES IT OFF.
            //
            // OxygenOS/ColorOS revokes the Accessibility grant when the app's versionCode
            // changes — the same behaviour already noted at the auto-capture toggle for
            // force-stop. Nothing up here knew that: `permissionsOk` is SMS-or-notification
            // only, so on 2026-09-06 this phone read CAPTURING in green immediately after the
            // v3.06 install had silently switched the screen reader off, in the one state where
            // no RRN can ever be read. The merchant's only clue was an Enable button two cards
            // further down, which is not a clue.
            //
            // Ranked above auto-capture because turning auto-capture off is something a person
            // chose; this is something the phone did to them without asking.
            !access -> "Screen reader off" to R.color.danger
            !Prefs.autoCapture(this) -> "Auto-capture is off" to R.color.warning
            else -> "Capturing" to R.color.success
        }
        val stateColor = ContextCompat.getColor(this, colorRes)
        b.heroTitle.text = title.uppercase()
        b.heroTitle.setTextColor(stateColor)
        b.heroDot.setColorFilter(stateColor)
        // The pill is tinted from the same colour at low alpha, so state reads before the words.
        b.heroPill.backgroundTintList = android.content.res.ColorStateList.valueOf(
            (stateColor and 0x00FFFFFF) or 0x24000000)

        // WHO this phone collects for, and THROUGH WHICH APP — the two facts that were nowhere on
        // screen while a merchant code typo ("GUFFI-01 hu") and a Paytm/PhonePe merchant mix-up
        // both went unnoticed for hours.
        val who = Prefs.merchantName(this).ifBlank { Prefs.merchantCode(this) }.ifBlank { "no merchant code" }
        b.heroDesc.text = when {
            !permissionsOk -> "Grant the permissions below to start."
            !hasCode -> "Enter the merchant code for this shop under CONNECTION, then Save."
            Prefs.merchantState(this) == -1 ->
                "The server does not know \"${Prefs.merchantCode(this)}\". Check it under CONNECTION — " +
                    "captures are stamped with this code, so a wrong one sends money to the wrong banker."
            !codeVerified -> "Tap Save under CONNECTION to verify this code with the server."
            app == null -> "Turn on the payment app you receive money on, below."
            !access -> "Updating the app switches this off. Tap Enable under RRN CAPTURE → " +
                "Screen reader and turn Katana Agent on — no RRN can be read until you do."
            !Prefs.autoCapture(this) -> "Turn Auto-capture back on to resume reading RRNs."
            // The engines read the PAYMENT APP, not this screen — so while the merchant is
            // looking at the agent, nothing is being captured. This phone idled for an hour that
            // way on 2026-08-22 with every indicator green.
            else -> "Leave ${labelFor(app)} open on screen — capture reads it there."
        }

        val merchant = Prefs.merchantCode(this).ifBlank { "—" }
        val hasMerchant = Prefs.merchantCode(this).isNotBlank()
        val mLabel = when {
            // Reached the server and it validated the code.
            Prefs.merchantState(this) == 1 -> "${Prefs.merchantName(this).ifBlank { merchant }} ✓ verified"
            // Enrolled with a code but the phone can't reach the server — the actionable case.
            hasMerchant && Prefs.enabled(this) && !Prefs.reachable(this) -> "$merchant ⚠ can't reach server — check internet"
            Prefs.merchantState(this) == -1 -> "$merchant ✗ not recognized"
            else -> "$merchant (save to verify)"
        }
        // THE PROOF LINE. A count that goes up is the only thing on this phone that says capture
        // is really happening; "last" is what turns a quiet stretch into either "fine" or "look
        // at me". Charging is here because the screen is only held on while plugged in, so an
        // unplugged phone stops capturing without anything else changing.
        val today = Prefs.capturesToday(this)
        val last = Prefs.lastCaptureAt(this)
        val lastLabel = if (last <= 0L) "none yet" else {
            val mins = (System.currentTimeMillis() - last) / 60000L
            val clock = java.text.SimpleDateFormat("HH:mm", java.util.Locale.US).format(java.util.Date(last))
            when {
                mins < 1 -> "$clock (just now)"
                mins < 60 -> "$clock ($mins min ago)"
                else -> "$clock (${mins / 60} h ago)"
            }
        }
        val charging = ScreenAwake.isCharging(this)
        val queued = OutboxStore.size(this)

        b.heroCount.text = today.toString()
        b.heroCount.setTextColor(ContextCompat.getColor(this, if (today > 0) R.color.on_surface else R.color.on_surface_variant))
        b.heroCountLabel.text = if (today == 1) "payment captured today" else "payments captured today"
        b.heroLast.text = if (last <= 0L) "no captures yet on this phone" else "last $lastLabel"
        b.heroLast.setTextColor(ContextCompat.getColor(this, if (last <= 0L) R.color.on_surface_variant else R.color.brand))

        // The button only appears once there is somewhere useful to send them.
        val pkg = app?.let { packageFor(it) }
        if (armed && app != null && pkg != null) {
            b.openAppBtn.visibility = android.view.View.VISIBLE
            b.openAppBtn.text = "Open ${labelFor(app)}"
            b.openAppBtn.setOnClickListener {
                runCatching { packageManager.getLaunchIntentForPackage(pkg) }.getOrNull()
                    ?.let { startActivity(it) }
                    ?: toast("${labelFor(app)} is not installed on this phone")
            }
        } else {
            b.openAppBtn.visibility = android.view.View.GONE
            android.util.Log.d("KATANA_UI", "open-app button hidden: armed=$armed app=$app pkg=$pkg")
        }

        b.statMerchant.text = who
        b.statVia.text = app?.let { shortLabelFor(it) } ?: "none selected"
        b.statPower.text = if (charging) "Plugged in" else "On battery"
        b.statPower.setTextColor(ContextCompat.getColor(this, if (charging) R.color.on_surface else R.color.warning))
        b.statQueue.text = if (queued == 0) "Clear" else "$queued pending"
        b.statQueue.setTextColor(ContextCompat.getColor(this, if (queued == 0) R.color.on_surface else R.color.warning))

        // Diagnostics, demoted: needed when something is wrong, noise when it is not.
        b.details.text = buildString {
            append("Merchant  ").append(mLabel).append('\n')
            append("Device    ").append(Prefs.deviceId(this@MainActivity)).append('\n')
            append("Endpoint  ").append(Prefs.baseUrl(this@MainActivity)).append('\n')
            append("Version   ").append(BuildConfig.VERSION_NAME)
            if (!charging) append('\n').append("⚠ Not charging — the screen will sleep and capture stops with it.")
        }
    }

    /** Re-render while the screen is open so the count and "last" actually move. */
    private val heroTicker = object : Runnable {
        override fun run() {
            refreshState(); refreshLog()
            b.root.postDelayed(this, 5_000L)
        }
    }

    override fun onPause() {
        super.onPause()
        b.root.removeCallbacks(heroTicker)
    }

    private fun refreshLog() {
        val log = AlertStore.recent(this)
        b.log.text = if (log.isBlank()) "(none yet)" else log
    }

    // One-tap Gmail connect: open the server's OAuth start URL in a browser. The user
    // picks their Google account, taps Allow, and the server stores the token. No app
    // password / IMAP needed.
    private fun connectGoogle() {
        if (Prefs.merchantCode(this).isBlank()) { toast("Set the merchant code first, then Save settings"); return }
        val base = Prefs.baseUrl(this).trimEnd('/')
        val url = "$base/api/oauth/google/start?m=${Uri.encode(Prefs.merchantCode(this))}&d=${Uri.encode(Prefs.deviceId(this))}"
        b.emailStatus.text = "Opening Google sign-in… approve it, then come back."
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        catch (e: Exception) { toast("No browser found") }
    }

    private fun saveEmail() {
        val email = b.emailAddr.text.toString().trim()
        val pass = b.emailPass.text.toString().trim()
        if (email.isEmpty()) { toast("Enter the Gmail address"); return }
        if (pass.isEmpty() && !Prefs.emailConnected(this)) { toast("Enter the 16-character app password"); return }
        if (Prefs.merchantCode(this).isBlank()) { toast("Set the merchant code first, then Save settings"); return }
        b.emailStatus.text = "Connecting…"
        AlertUploader.saveEmailConfig(this, email, pass) { ok, msg ->
            runOnUiThread {
                Prefs.setEmailConnected(this, email, ok)
                b.emailStatus.text = if (ok) "✓ Connected: $email" else "✗ ${msg.ifBlank { "could not connect" }}"
                if (ok) b.emailPass.setText("")
                toast(if (ok) "Gmail connected" else "Failed — check the app password & IMAP")
            }
        }
    }

    private fun sendTestAlert() {
        val utr = Random.nextLong(100000000000L, 999999999999L).toString()
        val txn = TxnParser.parse("Rs.1.00 credited to test@upi UPI Ref $utr -HDFC Bank", "HDFCBK")
        if (txn == null) { toast("Parser returned null"); return }
        AlertUploader.send(this, txn, "DEVICE", "HDFCBK")
        toast("Test alert sent")
        Handler(Looper.getMainLooper()).postDelayed({ refreshLog(); refreshState() }, 1500)
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}
