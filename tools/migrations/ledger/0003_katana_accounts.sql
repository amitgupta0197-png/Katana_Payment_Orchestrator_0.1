-- ledgerservice_db: the ledger accounts of Katana's own rail are named after it.
--
-- Account codes end in the rail's provider code (ASSETS.CLEARING.<provider>, …). The rail is
-- renamed to katana (routingEngine 0003), so its accounts are renamed with it; otherwise the
-- next posting would open a second set of accounts and split the rail's history in two.
-- An account that already exists under the new code is left alone and the old one keeps its
-- name. Only the code changes: ids, balances and every posted line are untouched.
--
-- ROLLBACK:
--   UPDATE accounts SET code = regexp_replace(code, '\.katana$', '.poolpay') WHERE code ~ '\.katana$';

UPDATE accounts a
   SET code = regexp_replace(a.code, '\.poolpay$', '.katana')
 WHERE a.code ~ '\.poolpay$'
   AND NOT EXISTS (
     SELECT 1 FROM accounts k
      WHERE k.tenant_id = a.tenant_id AND k.code = regexp_replace(a.code, '\.poolpay$', '.katana'));
