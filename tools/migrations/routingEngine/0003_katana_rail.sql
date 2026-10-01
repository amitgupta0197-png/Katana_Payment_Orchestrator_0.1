-- routingengineservice_db: Katana's own rail is called katana.
--
-- The routing engine's rails were seeded with a provider code carried over from the BRD. The
-- adapter for it is now registered as KATANA (lib/payment-adapters), so the rail rows follow.
-- A rail that already exists under the new code for the same method and direction wins and
-- the old row is dropped. Past routing_decisions keep the code they were decided with.
--
-- Apply together with the code that registers the KATANA adapter (build first, then apply
-- and restart at once): code from before the rename has no adapter for the new code.
--
-- ROLLBACK: UPDATE rails SET provider = 'poolpay' WHERE provider = 'katana';

DELETE FROM rails o
 WHERE lower(o.provider) = 'poolpay'
   AND EXISTS (SELECT 1 FROM rails k
                WHERE lower(k.provider) = 'katana' AND k.method = o.method AND k.direction = o.direction);

UPDATE rails SET provider = 'katana' WHERE lower(provider) = 'poolpay';
