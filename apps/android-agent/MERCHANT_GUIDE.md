# Katana Agent — Merchant Setup Guide

The Katana Agent runs on an Android phone and automatically reads the **RRN** (12‑digit
UPI reference) off each Paytm Business payment, then sends it to Katana. On the dashboard
those payments stop showing **"no RRN"** and get their reference filled in — with no manual
typing.

## What you need

- An **Android phone (Android 11 or newer)** — ideally a **dedicated phone** left on and
  charging.
- **Paytm Business** installed and **logged in** on that phone.
- Your **Merchant code** (e.g. `MTCI-01`).

> Tip: a dedicated capture phone that stays on the Paytm payments screen works best. The
> agent can only read what is on screen, so the phone should be left showing Paytm.

## One‑time setup (about 5 minutes)

1. **Install** the Katana Agent APK and open it.
2. In **Connection**, enter your **Merchant code** and tap **Save settings**.
   - The status should change to **`✓ verified`**. If it says *not recognized*, re‑check the
     code.
3. Grant the permissions the app lists:
   - **Screen reader (Accessibility)** — tap **Enable**, then turn **Katana Agent** on in the
     system list. *(Required to read the RRN.)*
   - **Display over other apps** — tap **Allow**. *(Required so it can read the copied RRN.)*
   - **Bank SMS**, **Notification access**, **Background activity** — grant these so bank/UPI
     credit alerts are also forwarded and the app stays alive.
4. Turn on **Auto‑capture**.

That's it. The top of the screen should read **"Agent active"** with a green dot.

## Daily use

- Keep the phone **on and charging**, with **Paytm Business open on the payments list**.
- New payments are opened, read, and their RRNs sent to Katana **automatically** — nothing to
  tap.

## Filling a specific payment on demand ("Get RRN")

On the dashboard, each credit that is still missing its reference has a **Get RRN** button.
Press it and the agent — as long as the phone has Paytm open on the payments list — will
**re‑read the list and fill that one in automatically**. The button clears itself once the RRN
lands. No action is needed on the phone.

## Good to know / limits

- **Paytm must be open on the payments list** for capture to work. The agent cannot read RRNs
  while Paytm is closed or in the background — this is a limitation of Android's accessibility
  approach, so a dedicated always‑on phone is recommended.
- Only **payments visible on the list** can be captured. Recent payments are captured
  automatically; a very old payment would need the Paytm list scrolled to it.
- Everything stays on the device except the captured reference — the app reads only Paytm
  screens.

## Quick troubleshooting

| Symptom | Fix |
| --- | --- |
| Status says "Setup needed" | Grant Bank SMS **or** Notification access; check **Agent enabled**. |
| Merchant shows "not recognized" | Re‑enter the exact merchant code and **Save settings** again. |
| RRNs not filling in | Make sure **Screen reader** + **Display over other apps** are granted, **Auto‑capture** is on, and **Paytm is open on the payments list**. |
| Stops after a while | Grant **Background activity** (battery) so the OS doesn't kill it; keep the phone charging. |
