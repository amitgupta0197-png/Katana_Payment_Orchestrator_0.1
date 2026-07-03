# Katana — Provider Portal Guide

A quick guide to using your Katana provider portal. Your portal only shows merchants and data **mapped to you**.

> In-app version: this same guide is available inside the portal under **Help & guide**.

---

## Signing in

- Go to your portal's **/login** page.
- Sign in with the **email** and **password** your Katana account manager shared with you.

---

## Dashboard

Live KPIs for your portfolio:
- **Mapped merchants** — total / live / in onboarding
- **Sub-MIDs** — live + pending KYC
- **Open KYB cases** — merchant underwriting in progress
- **MTD / YTD commission earned**

The **Insights** charts show pay-in volume, status breakdown, collected ₹, and channel mix across your merchants. The **onboarding funnel** shows where each merchant sits across the 6 stages: APPLICATION → DOCS_PENDING → SCREENING → BANK_VERIFY → CONFIG → LIVE.

---

## 1. Add a merchant lead

Onboard a new merchant under your account.

**Steps**
1. Go to **Leads** → click **New lead**.
2. Fill in the merchant's details: code, legal name, brand, business type, contact email & phone, website.
3. Submit. The merchant is created at the **APPLICATION** stage and auto-mapped to you.
4. A **merchant login is created automatically** — a one-time password is shown. Share it with the merchant so they can sign in to their own portal.

**Notes**
- You can only create leads under your own account, and you only see leads you created.
- From there the merchant progresses through the onboarding funnel.

---

## 2. Your merchants

- Open **Merchants** to see your approved & live merchants.
- Click a merchant to view its details, its **Sub-MIDs** (code, mode, KYC, settlement), and its **rolling reserves** (hold amount, release date, status).
- This view is **read-only** — onboarding starts from **Leads**; merchant edits are made by the merchant or Katana.

---

## 3. Transactions & reimbursement

- Open **Transactions** to see gross value across all channels (Katana Pay, PayU, Cashfree, Razorpay, …) for your mapped merchants.
- Broken down **by merchant** and **by channel**, with recent activity.
- **Gross counts successful collections only** — this is the reimbursable value your commission is based on.

---

## 4. Request a Sub-MID

Provision a new MID for one of your merchants.

**Steps**
1. Go to **Sub-MIDs** → click **Request Sub-MID**.
2. Pick the **merchant** (from your mapped merchants) and the **Main MID**, enter a **Sub-MID code**, and choose a **mode**.
3. Submit. It's created with `PENDING` KYC and settlement off; a Katana admin then reviews and enables it.

**Modes & lifecycle**
- `TRAFFIC` — can start taking traffic right away.
- `KYC_APPROVED` — requires the merchant's KYC to be approved first.
- KYC status moves `PENDING → APPROVED`; settlement is enabled separately by Katana.
- You can only request Sub-MIDs for merchants mapped to you.

---

## 5. Commission

- Open **Commission** to see your **MTD** and **YTD** earnings and the active **rules** (rate in basis points, fixed fee, validity dates).
- Rates are set by Katana and are read-only here.
- Commission accrues on the successful gross shown in **Transactions**.

---

## 6. Your KYC

- Open **KYC** to see your provider status and the required document checklist: PAN, GST, CIN, MOA, AOA, board resolution, address proof, bank statement.
- Statuses follow `PENDING → APPROVED` (or `REJECTED` / `EXPIRED`).
- If document upload isn't available to you yet, send your documents to your Katana account manager.

---

## 7. Support

For help, use the **Support** tab or reach the Katana team on the `#katana-providers` channel / your account manager.

---

*Need more help? Contact your Katana account manager.*
