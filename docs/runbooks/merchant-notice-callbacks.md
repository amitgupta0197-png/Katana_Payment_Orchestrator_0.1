# Merchant notice: an order told Expired or Failed can still be paid

Phase 0 of the simplification plan: a notice to every integrated merchant, sent before any v2
work reaches them. It changes nothing in their integration; it tells them about behaviour that
is already live (since 2026-10-02) and that some handlers do not expect.

Send it from the account manager's own address or the merchant's Telegram group. It names no
payment processor, and must not be edited to name one.

---

**Subject: Katana Pay: a second callback when a late payment arrives**

Hello,

One thing about status callbacks that your integration should handle. Nothing needs to change
on your side if it already does.

**What happens.** When an order's time runs out we send your server a callback with
`STATUS: "Expired"`. When a payment attempt is declined we send `STATUS: "Failed"`. Sometimes
the customer's bank authorises the payment after that. The money has then reached you, so we
mark the order paid and send a **second callback** for the same `ORDER_ID`, with
`STATUS: "Captured"` and the bank reference in `RRN`.

**What to check in your callback handler.**

1. Do not treat `Expired` or `Failed` as final. Let a later `Captured` for the same `ORDER_ID`
   overwrite it and deliver the order.
2. If you ignore repeat callbacks, ignore them by `ORDER_ID` **and** `STATUS`, not by
   `ORDER_ID` alone. A handler that drops every second callback for an order will drop the
   `Captured` one.
3. `Captured` is final. Nothing is sent after it.
4. Before you refuse to deliver an order because it expired, read its status once:
   `GET https://katanapay.co/api/pay-status/{order id}`. The status API is the record;
   a callback is a notification and can be delayed.

**How to try it.** In your portal, open **Webhooks & keys** and use **Send test event** to
send your callback URL a sample of each status. Under **Orders** you can find any order by
your own reference or the bank reference and see every callback we sent for it and what your
server answered.

The integration guide has a sample of each callback:
https://katanapay.co/katana-pay-integration.html (section 6).

If your handler needs a change and you would like us to test it with you, reply to this
message.

Katana Pay support
