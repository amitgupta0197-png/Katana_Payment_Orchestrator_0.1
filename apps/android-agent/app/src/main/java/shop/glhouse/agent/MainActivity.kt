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

        b.saveBtn.setOnClickListener {
            Prefs.save(this, b.baseUrl.text.toString(), b.deviceId.text.toString(), b.merchantCode.text.toString(), b.enabled.isChecked)
            toast("Settings saved")
            refreshState()
            AgentWorker.schedule(this)
            if (Prefs.enabled(this)) {
                AlertUploader.heartbeat(this, notifAccessGranted())
                KeepAliveService.start(this)
            } else {
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
        b.autoCaptureSwitch.isChecked = Prefs.autoCapture(this)
        b.autoCaptureSwitch.setOnCheckedChangeListener { _, v -> Prefs.setAutoCapture(this, v) }
        b.testBtn.setOnClickListener { sendTestAlert() }

        b.emailAddr.setText(Prefs.emailAddr(this))
        b.emailStatus.text = if (Prefs.emailConnected(this)) "✓ Connected: ${Prefs.emailAddr(this)}" else "Not connected"
        b.emailSaveBtn.setOnClickListener { saveEmail() }
        b.emailGoogleBtn.setOnClickListener { connectGoogle() }

        AgentWorker.schedule(this)
    }

    override fun onResume() {
        super.onResume()
        refreshState()
        refreshLog()
        if (Prefs.enabled(this)) {
            AlertUploader.heartbeat(this, notifAccessGranted())
            thread { AlertUploader.flushOutbox(this) }
            KeepAliveService.start(this)   // keep the process alive for the notif listener
            Handler(Looper.getMainLooper()).postDelayed({ refreshState() }, 1600)
        } else {
            KeepAliveService.stop(this)
        }
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
        setRow(sms, b.smsCheck, b.smsBtn)
        setRow(notif, b.notifCheck, b.notifBtn)
        setRow(batt, b.batteryCheck, b.batteryBtn)
        setRow(accessGranted(), b.accessCheck, b.accessBtn)
        setRow(overlayGranted(), b.overlayCheck, b.overlayBtn)

        val ready = Prefs.enabled(this) && (sms || notif)
        val stateColor = ContextCompat.getColor(this, if (ready) R.color.success else R.color.warning)
        b.heroTitle.text = if (ready) "Agent active" else "Setup needed"
        b.heroTitle.setTextColor(stateColor)
        b.heroDot.setColorFilter(stateColor)
        b.heroDesc.text = if (ready) "Forwarding bank credits to Katana." else "Grant the permissions below to start."

        val merchant = Prefs.merchantCode(this).ifBlank { "—" }
        val mLabel = when (Prefs.merchantState(this)) {
            1 -> "${Prefs.merchantName(this).ifBlank { merchant }} ✓ verified"
            -1 -> "$merchant ✗ not recognized"
            else -> "$merchant (save to verify)"
        }
        b.details.text = buildString {
            append("Version    ").append(BuildConfig.VERSION_NAME).append(" (").append(BuildConfig.VERSION_CODE).append(")").append('\n')
            append("Endpoint   ").append(Prefs.baseUrl(this@MainActivity)).append("/api/v1/txn-alert").append('\n')
            append("Device     ").append(Prefs.deviceId(this@MainActivity)).append('\n')
            append("Merchant   ").append(mLabel).append('\n')
            append("Queued     ").append(OutboxStore.size(this@MainActivity)).append(" pending retry")
        }
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
