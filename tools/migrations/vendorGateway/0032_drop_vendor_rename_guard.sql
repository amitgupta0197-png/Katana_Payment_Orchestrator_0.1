-- vendorgatewayservice_db: the rename guard from 0031 is no longer needed.
--
-- 0031 left a trigger that stored an order written under the old vendor name as KATANA, to
-- cover a request in flight while the renamed code went live. That code has been live since
-- 2026-10-01 and nothing writes the old name any more, so the guard goes.

DROP TRIGGER IF EXISTS katana_vendor_name_trg ON vendor_payin_orders;
DROP FUNCTION IF EXISTS katana_vendor_name();
