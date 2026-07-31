/**
 * Gmail → Katana Paytm forwarder (Google Apps Script).
 *
 * Two jobs, both time-triggered:
 *   A) forwardPaytmPayments — real-time. Finds new Paytm "Payment Received" emails and
 *      POSTs each to /api/v1/paytm-email (amount + Order ID + payer → instant confirm).
 *   B) forwardPaytmReports  — RRN backfill. Finds Paytm transaction/settlement-report
 *      emails, and POSTs each CSV attachment to /api/v1/paytm-report (RRN matched by
 *      Order ID onto the already-captured payment).
 *
 * Processed threads get a label so they're never re-sent; the server also de-dups on the
 * Order ID, so a re-run is harmless.
 *
 * SETUP (5 minutes):
 *   1. https://script.google.com → New project.
 *   2. Delete the sample code, paste this whole file, Save.
 *   3. Edit CONFIG below (MERCHANT_ID optional; adjust REPORT_SEARCH to match how Paytm
 *      sends your report email — see the note on that line).
 *   4. Run `installTrigger` once → approve the Gmail + external-request permissions.
 *   5. Test: run `forwardPaytmPayments` and `forwardPaytmReports` once and check Logs.
 *
 * NOTE: report forwarding only works if Paytm ATTACHES the CSV to the email. If Paytm
 * instead emails a download LINK (login-gated), auto-forward can't fetch it — use a
 * daily manual upload of the report CSV to /api/v1/paytm-report instead.
 */

var CONFIG = {
  PAYMENT_ENDPOINT: "https://glhouse.shop/api/v1/paytm-email",
  REPORT_ENDPOINT:  "https://glhouse.shop/api/v1/paytm-report",
  MERCHANT_ID: "",                 // optional: your merchant code (leave "" if unsure)
  PAYMENT_LABEL: "KatanaForwarded",
  REPORT_LABEL:  "KatanaReportSent",
  // Real-time payment emails.
  PAYMENT_SEARCH: 'from:no-reply@paytm.com (subject:"paid at" OR "Payment Received") newer_than:2d',
  // Report emails. Tune to your actual report mail: Paytm reports often come from a
  // different sender/subject (e.g. "settlement report", "transaction report"). Widen if
  // unsure, e.g.  'from:paytm has:attachment filename:csv newer_than:3d'
  REPORT_SEARCH: 'from:paytm (subject:report OR subject:settlement OR subject:transaction) has:attachment newer_than:3d',
  MAX_PER_RUN: 25,
};

function forwardPaytmPayments() {
  var label = GmailApp.getUserLabelByName(CONFIG.PAYMENT_LABEL) || GmailApp.createLabel(CONFIG.PAYMENT_LABEL);
  var threads = GmailApp.search(CONFIG.PAYMENT_SEARCH + " -label:" + CONFIG.PAYMENT_LABEL, 0, CONFIG.MAX_PER_RUN);
  var sent = 0, failed = 0;

  for (var t = 0; t < threads.length; t++) {
    var msgs = threads[t].getMessages();
    var allOk = true;
    for (var m = 0; m < msgs.length; m++) {
      var msg = msgs[m];
      if ((msg.getFrom() || "").toLowerCase().indexOf("paytm") === -1) continue;
      var payload = { from: msg.getFrom() || "", subject: msg.getSubject() || "", text: msg.getPlainBody() || msg.getBody() || "" };
      if (CONFIG.MERCHANT_ID) payload.merchant_id = CONFIG.MERCHANT_ID;
      if (!post(CONFIG.PAYMENT_ENDPOINT, JSON.stringify(payload), "application/json")) { failed++; allOk = false; } else { sent++; }
    }
    if (allOk) threads[t].addLabel(label);
  }
  Logger.log("Paytm payments: sent=" + sent + " failed=" + failed + " threads=" + threads.length);
}

function forwardPaytmReports() {
  var label = GmailApp.getUserLabelByName(CONFIG.REPORT_LABEL) || GmailApp.createLabel(CONFIG.REPORT_LABEL);
  var threads = GmailApp.search(CONFIG.REPORT_SEARCH + " -label:" + CONFIG.REPORT_LABEL, 0, CONFIG.MAX_PER_RUN);
  var sent = 0, failed = 0, csvs = 0;

  for (var t = 0; t < threads.length; t++) {
    var msgs = threads[t].getMessages();
    var allOk = true;
    for (var m = 0; m < msgs.length; m++) {
      var atts = msgs[m].getAttachments();
      for (var a = 0; a < atts.length; a++) {
        var name = (atts[a].getName() || "").toLowerCase();
        var isCsv = name.indexOf(".csv") !== -1 || (atts[a].getContentType() || "").indexOf("csv") !== -1;
        if (!isCsv) continue;                       // xlsx/pdf attachments aren't parseable here
        csvs++;
        var body = JSON.stringify({ csv: atts[a].getDataAsString(), merchant_id: CONFIG.MERCHANT_ID || undefined });
        if (!post(CONFIG.REPORT_ENDPOINT, body, "application/json")) { failed++; allOk = false; } else { sent++; }
      }
    }
    if (allOk) threads[t].addLabel(label);
  }
  Logger.log("Paytm reports: csvFound=" + csvs + " sent=" + sent + " failed=" + failed + " threads=" + threads.length);
}

// POST helper. Returns true on 2xx; logs otherwise.
function post(url, body, contentType) {
  try {
    var res = UrlFetchApp.fetch(url, {
      method: "post", contentType: contentType, headers: { "x-sandbox": "1" },
      payload: body, muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    if (code >= 200 && code < 300) return true;
    Logger.log("HTTP " + code + " @ " + url + " → " + res.getContentText());
    return false;
  } catch (e) { Logger.log("POST failed @ " + url + ": " + e); return false; }
}

/**
 * Run ONCE to schedule both jobs. Payments every minute; reports every 5 minutes.
 * (Apps Script time-triggers only allow 1/5/10/15/30-min intervals — 3 min isn't
 * selectable, so reports use the 5-min slot. Change everyMinutes(5)→(1) for faster.)
 * NOTE: actual RRN freshness = how often Paytm emails the report, not this interval.
 */
function installTrigger() {
  var keep = { forwardPaytmPayments: 1, forwardPaytmReports: 1 };
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (keep[existing[i].getHandlerFunction()]) ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger("forwardPaytmPayments").timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger("forwardPaytmReports").timeBased().everyMinutes(5).create();
  Logger.log("Triggers installed — payments every minute, reports every 5 minutes.");
}
