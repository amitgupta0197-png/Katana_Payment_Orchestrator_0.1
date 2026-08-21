#!/usr/bin/env bash
# Pull the newest Paytm "Payment Statement" off a connected capture phone and import it.
#
# WHY THIS EXISTS. On-screen capture only works while the screen can be driven, so it will
# always miss some payments — and it cannot tell you which, because it counts what it saw.
# Paytm's own statement is the independent ledger: every row carries an RRN, and importing it
# reconciles Katana against Paytm exactly. On 2026-08-21 it closed a 64-payment gap to zero.
#
# WHAT THIS DOES *NOT* DO, DELIBERATELY: it does not tap through Paytm to generate the report.
# That screen carries "Settle Now" and "Refund to Customer", and a script tapping fixed
# coordinates on it would eventually press one — during this work a stray swipe opened the
# refund flow on a real ₹2,000 payment. Generating the report is three taps by a human; every
# tedious step after it is automated here.
#
# GENERATE THE REPORT FIRST, on the phone:
#   Paytm → the "₹… from N Payment, Today" card → ⤓ (top right)
#          → select "Today" → "Download for <date>"
#   wait ~1 min, then: ☰ → Business Details → Payment Reports
#          → Payment History & Reports → tap the file icon on the newest row
#
# THEN RUN:  tools/scripts/paytm-import.sh <BANKER_CODE>     e.g.  paytm-import.sh AVTS23
set -euo pipefail

MERCHANT="${1:-}"
if [[ -z "$MERCHANT" ]]; then
  echo "usage: $(basename "$0") <BANKER_CODE> [--dry-run]" >&2
  echo "  e.g. $(basename "$0") AVTS23" >&2
  exit 2
fi
DRY=""
[[ "${2:-}" == "--dry-run" ]] && DRY="&dry_run=1"

VPS="${KATANA_VPS:-root@72.61.227.233}"
KEY="${KATANA_SSH_KEY:-$HOME/.ssh/katana_vps}"
REMOTE_APP="/opt/katana/apps/admin-dashboard"
PAYTM_DL="/storage/emulated/0/Android/data/com.paytm.business/files/Download"

command -v adb >/dev/null || { echo "adb not on PATH" >&2; exit 1; }
[[ -n "$(adb devices | awk 'NR>1 && $2=="device"')" ]] || {
  echo "no phone connected (adb devices shows none)" >&2; exit 1; }

# NEWEST BY MODIFICATION TIME, not by name: Paytm names same-day exports
# "Payment_Statement_21_Aug_2026(1).csv", "(2)", … so lexical order is not chronological and
# would happily import a stale morning file over a fresh evening one.
echo "→ finding the newest statement on the phone…"
CSV="$(adb shell "ls -t $PAYTM_DL/*.csv 2>/dev/null | head -1" | tr -d '\r')"
[[ -n "$CSV" ]] || {
  echo "no statement CSV on the phone — generate it in Paytm first (see the header of this script)" >&2
  exit 1; }
echo "  $CSV"

TMP="$(mktemp -t paytm-statement)"
trap 'rm -f "$TMP"' EXIT
adb pull "$CSV" "$TMP" >/dev/null
ROWS=$(($(wc -l < "$TMP") - 1))
echo "→ pulled $ROWS rows"

# Fail loudly on the wrong file rather than posting rubbish at the reconciler.
head -1 "$TMP" | grep -q "RRN" || {
  echo "that file has no RRN column — is it a settlement report rather than a payment statement?" >&2
  exit 1; }

echo "→ uploading and importing as $MERCHANT…"
scp -i "$KEY" -o ConnectTimeout=10 "$TMP" "$VPS:/tmp/paytm-statement.csv" >/dev/null
ssh -i "$KEY" -o ConnectTimeout=10 "$VPS" \
  "cd $REMOTE_APP && K=\$(grep '^FIFO_CRON_KEY=' .env.local | cut -d= -f2- | tr -d '\"\r') && \
   curl -s --max-time 280 -X POST \
     'http://127.0.0.1:3100/api/v1/reports/paytm-import?merchant_id=$MERCHANT$DRY' \
     -H \"x-cron-key: \$K\" -H 'content-type: text/csv' \
     --data-binary @/tmp/paytm-statement.csv; rm -f /tmp/paytm-statement.csv"
echo
echo "DUPLICATE = already captured live (deduped on RRN, not double-counted)."
echo "UNMATCHED = recovered by this import."
