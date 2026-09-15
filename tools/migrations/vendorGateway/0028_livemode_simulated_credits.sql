-- vendorgatewayservice_db: TEST / LIVE MODE — simulated credits are test credits.
--
-- 0026 added vendor_txn_alerts.livemode with DEFAULT true, so every credit captured before
-- test mode shipped reads as live — including the ones "Simulate bank credit" created. Those
-- were never money: the simulator builds a synthetic alert (source SIMULATED, device
-- sim-device-01) to settle a demo order. Since the reconciler now stamps them livemode = false,
-- this brings the older rows into line so statements, the banker and merchant credit totals and
-- the Telegram collections report stop counting them once their live-only filters ship.
--
-- Safe to apply before or after that code: the current code writes SIMULATED credits as test
-- already, and before the filters ship nothing reads the column.

UPDATE vendor_txn_alerts SET livemode = false
 WHERE livemode = true AND source = 'SIMULATED';
