/**
 * Gmail → Katana Paytm-email forwarder (Google Apps Script).
 *
 * Runs on a time trigger, finds new Paytm "Payment Received" emails, and POSTs each to
 * the orchestrator's /api/v1/paytm-email endpoint (which parses amount + Order ID + payer
 * and feeds the reconciler). Processed threads get a label so they're never re-sent; the
 * server also de-dups on the Order ID, so a re-run is harmless.
 *
 * SETUP (5 minutes):
 *   1. Go to https://script.google.com  →  New project.
 *   2. Delete the sample code, paste this whole file, Save.
 *   3. Edit CONFIG below (MERCHANT_ID optional).
 *   4. Run `installTrigger` once → approve the Gmail + external-request permissions.
 *   5. Done. It now checks every minute. Run `forwardPaytmPayments` once to test.
 */

var CONFIG = {
  ENDPOINT: "https://glhouse.shop/api/v1/paytm-email",
  MERCHANT_ID: "",            // optional: your merchant code (leave "" if unsure)
  LABEL: "KatanaForwarded",   // applied to processed threads so they're skipped next run
  // Only look at recent Paytm payment mails. Widen to newer_than:7d for a backfill run.
  SEARCH: 'from:no-reply@paytm.com (subject:"paid at" OR "Payment Received") newer_than:2d',
  MAX_PER_RUN: 25,
};

function forwardPaytmPayments() {
  var label = GmailApp.getUserLabelByName(CONFIG.LABEL) || GmailApp.createLabel(CONFIG.LABEL);
  var threads = GmailApp.search(CONFIG.SEARCH + " -label:" + CONFIG.LABEL, 0, CONFIG.MAX_PER_RUN);
  var sent = 0, failed = 0;

  for (var t = 0; t < threads.length; t++) {
    var msgs = threads[t].getMessages();
    var allOk = true;
    for (var m = 0; m < msgs.length; m++) {
      var msg = msgs[m];
      var from = msg.getFrom() || "";
      if (from.toLowerCase().indexOf("paytm") === -1) continue;

      var payload = {
        from: from,
        subject: msg.getSubject() || "",
        text: msg.getPlainBody() || msg.getBody() || "",
      };
      if (CONFIG.MERCHANT_ID) payload.merchant_id = CONFIG.MERCHANT_ID;

      try {
        var res = UrlFetchApp.fetch(CONFIG.ENDPOINT, {
          method: "post",
          contentType: "application/json",
          headers: { "x-sandbox": "1" },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true,
        });
        var code = res.getResponseCode();
        if (code >= 200 && code < 300) { sent++; }
        else { failed++; allOk = false; Logger.log("HTTP " + code + " → " + res.getContentText()); }
      } catch (e) {
        failed++; allOk = false; Logger.log("POST failed: " + e);
      }
    }
    // Only mark the thread done if every Paytm message in it posted OK — so a transient
    // failure is retried on the next run instead of being silently dropped.
    if (allOk) threads[t].addLabel(label);
  }
  Logger.log("Paytm forwarder: sent=" + sent + " failed=" + failed + " threads=" + threads.length);
}

/** Run ONCE to schedule forwardPaytmPayments every minute. */
function installTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === "forwardPaytmPayments") ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger("forwardPaytmPayments").timeBased().everyMinutes(1).create();
  Logger.log("Trigger installed — forwarding every minute.");
}
